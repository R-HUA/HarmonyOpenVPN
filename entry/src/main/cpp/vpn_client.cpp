/*
 * Copyright (c) 2023 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <napi/native_api.h>
#include <client/ovpncli.hpp>
#include <openvpn/ssl/tlsver.hpp>
#include <openvpn/ssl/proto_context_options.hpp>
#include <openvpn/tun/builder/capture.hpp>
#include <unistd.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include "model.hpp"

struct Request {
    std::mutex mutex;
    std::condition_variable cv;
    bool done = false, cancelled = false, tun = false;
    int result = -1, socket = -1;
    std::string config;
    void finish(int value) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!done) { result = value; done = true; cv.notify_all(); }
    }
};
struct Client;
struct Session {
    std::shared_ptr<Client> client;
    std::thread worker;
    std::mutex pendingMutex, joinMutex;
    std::vector<std::weak_ptr<Request>> pending;
    std::atomic<bool> cancelled{false};
    bool networkPaused = false; // accessed only by the N-API thread
    napi_threadsafe_function protect{}, tun{}, events{}, stats{}, exit{};
    void stop();
    void join() { std::lock_guard<std::mutex> lock(joinMutex); if (worker.joinable()) worker.join(); }
};
static std::shared_ptr<Session> active;
static napi_value undefined(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
static napi_value str(napi_env env, const std::string &s) {
    napi_value v; napi_create_string_utf8(env, s.data(), s.size(), &v); return v;
}
static std::string readString(napi_env env, napi_value v) {
    size_t n = 0;
    if (napi_get_value_string_utf8(env, v, nullptr, 0, &n) != napi_ok || n > 2 * 1024 * 1024)
        throw std::runtime_error("Invalid or oversized string");
    std::vector<char> b(n + 1); napi_get_value_string_utf8(env, v, b.data(), b.size(), &n);
    return std::string(b.data(), n);
}
static void clearException(napi_env env) {
    bool pending = false; napi_is_exception_pending(env, &pending);
    if (pending) { napi_value e; napi_get_and_clear_last_exception(env, &e); }
}
static void deliverText(napi_env env, napi_value cb, void*, void *data) {
    std::unique_ptr<std::string> text(static_cast<std::string*>(data));
    if (!env || !cb) return;
    napi_value arg = str(env, *text), receiver = undefined(env);
    napi_call_function(env, receiver, cb, 1, &arg, nullptr); clearException(env);
}
static void emit(napi_threadsafe_function fn, const std::string &s) {
    auto data = new std::string(s);
    if (!fn || napi_call_threadsafe_function(fn, data, napi_tsfn_nonblocking) != napi_ok) delete data;
}
struct Completion { std::shared_ptr<Request> request; bool success; };
static napi_value completeRequest(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value arg{}; void *data{};
    napi_get_cb_info(env, info, &argc, &arg, nullptr, &data);
    auto *c = static_cast<Completion*>(data);
    int32_t result = c->success ? 0 : -1;
    if (c->success && c->request->tun) {
        result = -1; if (argc) napi_get_value_int32(env, arg, &result);
    }
    c->request->finish(result); return undefined(env);
}
static napi_value completion(napi_env env, std::shared_ptr<Request> request, bool success) {
    auto *data = new Completion{request, success}; napi_value fn;
    napi_create_function(env, "vpnCompletion", NAPI_AUTO_LENGTH, completeRequest, data, &fn);
    napi_add_finalizer(env, fn, data, [](napi_env, void *p, void*) { delete static_cast<Completion*>(p); }, nullptr, nullptr);
    return fn;
}
static void deliverRequest(napi_env env, napi_value cb, void*, void *data) {
    std::unique_ptr<std::shared_ptr<Request>> holder(static_cast<std::shared_ptr<Request>*>(data));
    auto r = *holder;
    if (!env || !cb) { r->finish(-1); return; }
    { std::lock_guard<std::mutex> lock(r->mutex); if (r->cancelled || r->done) return; }
    napi_value arg, result{}, receiver = undefined(env);
    if (r->tun) arg = str(env, r->config); else napi_create_int32(env, r->socket, &arg);
    if (napi_call_function(env, receiver, cb, 1, &arg, &result) != napi_ok) {
        clearException(env); r->finish(-1); return;
    }
    bool promise = false; napi_is_promise(env, result, &promise);
    if (!promise) { r->finish(-1); return; } // protect must actually finish before routing traffic
    napi_value then; napi_get_named_property(env, result, "then", &then);
    napi_value callbacks[] = {completion(env, r, true), completion(env, r, false)};
    if (napi_call_function(env, result, then, 2, callbacks, nullptr) != napi_ok) {
        clearException(env); r->finish(-1);
    }
}
static int request(Session &s, std::shared_ptr<Request> r) {
    {
        std::lock_guard<std::mutex> lock(s.pendingMutex);
        if (s.cancelled) return -1;
        s.pending.erase(std::remove_if(s.pending.begin(), s.pending.end(), [](auto &p) { return p.expired(); }), s.pending.end());
        s.pending.push_back(r);
    }
    auto *data = new std::shared_ptr<Request>(r);
    auto fn = r->tun ? s.tun : s.protect;
    if (napi_call_threadsafe_function(fn, data, napi_tsfn_nonblocking) != napi_ok) { delete data; return -1; }
    std::unique_lock<std::mutex> lock(r->mutex);
    if (!r->cv.wait_for(lock, std::chrono::seconds(30), [&] { return r->done || r->cancelled; })) r->cancelled = true;
    return r->cancelled ? -1 : r->result;
}
struct Client : openvpn::ClientAPI::OpenVPNClient {
    Session &session;
    OvpnTunConfig tunConfig;
    explicit Client(Session &s) : session(s) {}
    bool pause_on_connection_timeout() override { return false; }
    std::string lastError;
    void log(const openvpn::ClientAPI::LogInfo &l) override {
        Json::Value j; j["name"] = "LOG"; j["info"] = l.text;
        emit(session.events, compactJson(j)); // ability redacts before persistence
    }
    void event(const openvpn::ClientAPI::Event &e) override {
        Json::Value j; j["name"] = e.name;
        j["info"] = e.info;
        if (e.error || e.fatal) lastError = e.name + (e.info.empty() ? "" : ": " + e.info);
        emit(session.events, compactJson(j));
    }
    void acc_event(const openvpn::ClientAPI::AppCustomControlMessageEvent&) override {}
    void external_pki_cert_request(openvpn::ClientAPI::ExternalPKICertRequest&) override {}
    void external_pki_sign_request(openvpn::ClientAPI::ExternalPKISignRequest&) override {}
    void clock_tick() override {
        if (session.cancelled) { stop(); return; }
        auto s = tun_stats(); Json::Value j;
        j["bytesIn"] = Json::Int64(s.bytesIn); j["bytesOut"] = Json::Int64(s.bytesOut);
        auto transport = transport_stats();
        j["transportBytesIn"] = Json::Int64(transport.bytesIn);
        j["transportBytesOut"] = Json::Int64(transport.bytesOut);
        j["transportPacketsIn"] = Json::Int64(transport.packetsIn);
        j["transportPacketsOut"] = Json::Int64(transport.packetsOut);
        Json::Value counters(Json::objectValue);
        const auto values = stats_bundle();
        for (size_t i = 0; i < values.size(); ++i)
            if (values[i]) counters[stats_name(static_cast<int>(i))] = Json::Int64(values[i]);
        j["coreCounters"] = counters;
        emit(session.stats, compactJson(j));
    }
    bool socket_protect(openvpn_io::detail::socket_type fd, std::string, bool) override {
        auto r = std::make_shared<Request>(); r->socket = fd; return request(session, r) == 0;
    }
    bool tun_builder_new() override { tunConfig = OvpnTunConfig{}; return true; }
    bool tun_builder_set_layer(int layer) override { return layer == 3; }
    bool tun_builder_set_remote_address(const std::string&, bool) override { return true; }
    bool tun_builder_add_address(const std::string &ip, int prefix, const std::string&, bool ipv6, bool) override {
        tunConfig.addresses.append(linkAddress(ip, prefix, ipv6));
        if (ipv6) tunConfig.v6 = true; else tunConfig.v4 = true;
        tunConfig.route(ip, prefix, ipv6); return true;
    }
    bool tun_builder_reroute_gw(bool v4, bool v6, unsigned int) override {
        if (v4) tunConfig.route("0.0.0.0", 0, false);
        if (v6) tunConfig.route("::", 0, true);
        return true;
    }
    bool tun_builder_add_route(const std::string &ip, int prefix, int, bool ipv6) override {
        tunConfig.route(ip, prefix, ipv6); return true;
    }
    bool tun_builder_exclude_route(const std::string &ip, int prefix, int, bool ipv6) override {
        tunConfig.route(ip, prefix, ipv6, true); return true;
    }
    bool tun_builder_set_dns_options(const openvpn::DnsOptions &dns) override {
        for (const auto &d : dns.search_domains) tunConfig.domains.append(d.domain);
        for (const auto &entry : dns.servers) {
            const auto &server = entry.second;
            if ((!server.domains.empty() && !dns.from_dhcp_options) || server.dnssec == openvpn::DnsServer::Security::Yes ||
                (server.transport != openvpn::DnsServer::Transport::Unset && server.transport != openvpn::DnsServer::Transport::Plain) ||
                !server.sni.empty()) throw std::runtime_error("Split DNS, required DNSSEC and encrypted DNS are unsupported");
            if (dns.from_dhcp_options) for (const auto &d : server.domains) tunConfig.domains.append(d.domain);
            for (const auto &a : server.addresses) {
                if (a.port != 0 && a.port != 53) throw std::runtime_error("Custom DNS ports are unsupported");
                netAddress(a.address, a.address.find(':') != std::string::npos);
                tunConfig.dns.append(a.address);
            }
        }
        return true;
    }
    bool tun_builder_set_mtu(int mtu) override {
        if (mtu < 576 || mtu > 1500) throw std::runtime_error("HarmonyOS VPN MTU must be 576..1500");
        tunConfig.mtu = mtu; return true;
    }
    bool tun_builder_set_session_name(const std::string&) override { return true; }
    bool tun_builder_set_proxy_auto_config_url(const std::string&) override { return false; }
    bool tun_builder_set_proxy_http(const std::string&, int) override { return false; }
    bool tun_builder_set_proxy_https(const std::string&, int) override { return false; }
    int tun_builder_establish() override {
        auto r = std::make_shared<Request>(); r->tun = true; r->config = compactJson(tunConfig.json());
        int fd = request(session, r);
        return fd < 0 ? -1 : dup(fd); // core owns duplicate; ability retains platform fd
    }
};
void Session::stop() {
    cancelled = true;
    { std::lock_guard<std::mutex> lock(pendingMutex);
      for (auto &weak : pending) if (auto r = weak.lock()) {
          std::lock_guard<std::mutex> rlock(r->mutex); r->cancelled = true; r->cv.notify_all();
      }
    }
    if (client) client->stop();
}
static openvpn::ClientAPI::Config configFor(const Json::Value &j) {
    openvpn::ClientAPI::Config c; c.content = j["content"].asString();
    c.privateKeyPassword = j.get("privateKeyPassword", "").asString();
    c.protoOverride = j.get("protocol", "").asString();
    if (c.protoOverride != "" && c.protoOverride != "tcp" && c.protoOverride != "udp") throw std::runtime_error("Invalid protocol");
    // The ability retains the platform TUN and reuses unchanged configuration.
    // Release the core duplicate on reconnect BEFORE a changed system TUN is rebuilt.
    c.connTimeout = 60; c.clockTickMS = 1000; c.tunPersist = false;
    c.compressionMode = j.get("compression", "no").asString();
    if (c.compressionMode != "no" && c.compressionMode != "asym")
        throw std::runtime_error("Only disabled or receive-only compression is supported");
    openvpn::ProtoContextCompressionOptions compression;
    compression.parse_compression_mode(c.compressionMode); c.allowUnusedAddrFamilies = "no";
    c.allowLocalLanAccess = false; c.tlsVersionMinOverride = "tls_1_2";
    // Validate the API override before eval_config; profile syntax uses a different vocabulary.
    auto minimum = openvpn::TLSVersion::Type::UNDEF;
    openvpn::TLSVersion::apply_override(minimum, c.tlsVersionMinOverride);
    return c;
}
static Json::Value parse(const std::string &s) {
    Json::CharReaderBuilder b; Json::Value j; std::string err;
    std::unique_ptr<Json::CharReader> reader(b.newCharReader());
    if (!reader->parse(s.data(), s.data() + s.size(), &j, &err) || !j.isObject()) throw std::runtime_error("Invalid connection options");
    return j;
}
static napi_value evaluate(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value arg; napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
    Json::Value j;
    try {
        Json::Value input; input["content"] = readString(env,arg);
        Session s; Client c(s); auto e = c.eval_config(configFor(input));
        j["error"] = e.error || e.externalPki; j["message"] = e.externalPki ? "External PKI is not supported; import an inline certificate/key profile" : e.message;
        j["autologin"] = e.autologin; j["username"] = e.userlockedUsername;
        j["challenge"] = e.staticChallenge; j["privateKeyPasswordRequired"] = e.privateKeyPasswordRequired;
    } catch (const std::exception &e) { j["error"] = true; j["message"] = e.what(); }
    return str(env,compactJson(j));
}
static void makeCallback(napi_env env, napi_value cb, const char *name, napi_threadsafe_function_call_js call, napi_threadsafe_function &fn) {
    if (napi_create_threadsafe_function(env,cb,nullptr,str(env,name),std::string(name) == "stats" ? 8 : 0,1,nullptr,nullptr,nullptr,call,&fn) != napi_ok)
        throw std::runtime_error("Cannot create native callback");
}
static void release(Session &s) {
    for (auto fn : {s.protect,s.tun,s.events,s.stats,s.exit}) if (fn) napi_release_threadsafe_function(fn,napi_tsfn_release);
}
static napi_value start(napi_env env,napi_callback_info info) {
    if (active) return str(env,"Previous VPN session must finish stopping first");
    size_t argc=7; napi_value args[7]{}; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
    auto s=std::make_shared<Session>();
    try {
        if (argc != 7) throw std::runtime_error("Expected seven arguments");
        auto j=parse(readString(env,args[0])); s->client=std::make_shared<Client>(*s);
        auto e=s->client->eval_config(configFor(j));
        if (e.error) throw std::runtime_error(e.message);
        if (e.externalPki) throw std::runtime_error("External PKI is unsupported");
        openvpn::ClientAPI::ProvideCreds creds;
        creds.username=j.get("username", "").asString(); creds.password=j.get("password", "").asString();
        creds.response=j.get("response", "").asString();
        if (!e.userlockedUsername.empty() && creds.username != e.userlockedUsername) throw std::runtime_error("Profile requires its locked username");
        if (!e.autologin && creds.username.empty()) throw std::runtime_error("Username is required");
        auto status=s->client->provide_creds(creds);
        if (status.error) throw std::runtime_error(status.message);
        makeCallback(env,args[1],"protect",deliverRequest,s->protect);
        makeCallback(env,args[2],"tun",deliverRequest,s->tun);
        makeCallback(env,args[3],"events",deliverText,s->events);
        makeCallback(env,args[5],"stats",deliverText,s->stats);
        makeCallback(env,args[6],"exit",deliverText,s->exit);
        active=s;
        s->worker=std::thread([s] {
            std::string reason="Disconnected";
            try {
                if (!s->cancelled) {
                    auto status=s->client->connect();
                    if (status.error) reason = status.status + (status.message.empty() ? "" : ": " + status.message);
                    if (!s->client->lastError.empty()) reason = s->client->lastError;
                    if (reason.empty()) reason = "OpenVPN disconnected without an error code";
                }
            } catch (const std::exception &e) { reason=e.what(); }
            if (!s->cancelled) emit(s->exit,reason);
            release(*s);
        });
        return undefined(env);
    } catch (const std::exception &e) {
        active.reset(); release(*s); return str(env,e.what());
    }
}
struct StopWork { std::shared_ptr<Session> session; napi_async_work work{}; napi_deferred deferred{}; };
static napi_value stop(napi_env env,napi_callback_info) {
    napi_value promise; napi_deferred deferred; napi_create_promise(env,&deferred,&promise);
    if (!active) { napi_resolve_deferred(env,deferred,undefined(env)); return promise; }
    active->stop(); auto w=new StopWork{active,{},deferred};
    napi_status st=napi_create_async_work(env,nullptr,str(env,"stopVpn"),[](napi_env,void *data){
        static_cast<StopWork*>(data)->session->join();
    },[](napi_env env,napi_status,void *data){
        std::unique_ptr<StopWork> w(static_cast<StopWork*>(data));
        if (active==w->session) active.reset();
        napi_resolve_deferred(env,w->deferred,undefined(env)); napi_delete_async_work(env,w->work);
    },w,&w->work);
    if (st != napi_ok || napi_queue_async_work(env,w->work) != napi_ok) {
        if(w->work) napi_delete_async_work(env,w->work);
        napi_reject_deferred(env,deferred,str(env,"Unable to queue VPN shutdown")); delete w;
    }
    return promise;
}
extern int runCbcSelfTest();
static napi_value networkChanged(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value arg; bool online = false;
    napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
    if (argc != 1 || napi_get_value_bool(env, arg, &online) != napi_ok) return undefined(env);
    auto session = active;
    if (!session || session->cancelled || !session->client) return undefined(env);
    if (!online) {
        session->networkPaused = true;
        session->client->pause("Physical network unavailable");
    } else if (session->networkPaused) {
        session->networkPaused = false;
        session->client->resume();
    } else {
        session->client->reconnect(0);
    }
    return undefined(env);
}
static napi_value selfTest(napi_env env, napi_callback_info) {
    try {
        const int result = runCbcSelfTest();
        return str(env, result == 0 ? "PASS: old CBC failure reproduced; patched AES CBC 15 round trips passed" : "FAIL CBC self-test stage=" + std::to_string(result));
    } catch (const std::exception &e) { return str(env, std::string("FAIL CBC self-test: ") + e.what()); }
}
static napi_value Init(napi_env env,napi_value exports) {
    napi_property_descriptor d[]={
        {"startVpn",nullptr,start,nullptr,nullptr,nullptr,napi_default,nullptr},
        {"stopVpn",nullptr,stop,nullptr,nullptr,nullptr,napi_default,nullptr},
        {"evaluateProfile",nullptr,evaluate,nullptr,nullptr,nullptr,napi_default,nullptr},
        {"selfTest",nullptr,selfTest,nullptr,nullptr,nullptr,napi_default,nullptr},
        {"networkChanged",nullptr,networkChanged,nullptr,nullptr,nullptr,napi_default,nullptr}};
    napi_define_properties(env,exports,5,d);
    napi_add_env_cleanup_hook(env,[](void*) { if(active) { active->stop();active->join();active.reset(); } },nullptr);
    return exports;
}
static napi_module module={1,0,nullptr,Init,"vpn_client",nullptr,{0}};
extern "C" __attribute__((constructor)) void RegisterEntryModule() { napi_module_register(&module); }
