// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <arpa/inet.h>
#include <json/json.h>
#include <stdexcept>
#include <string>
#include <vector>

inline std::string compactJson(const Json::Value &v) {
    Json::StreamWriterBuilder w; w["indentation"] = ""; return Json::writeString(w, v);
}
inline Json::Value netAddress(const std::string &ip, bool ipv6) {
    unsigned char bytes[16]{};
    if (inet_pton(ipv6 ? AF_INET6 : AF_INET, ip.c_str(), bytes) != 1)
        throw std::runtime_error("Invalid VPN IP address");
    Json::Value out; out["address"] = ip; out["family"] = ipv6 ? 2 : 1; out["port"] = 0;
    return out;
}
inline Json::Value linkAddress(const std::string &ip, int prefix, bool ipv6, bool network = false) {
    if (prefix < 0 || prefix > (ipv6 ? 128 : 32)) throw std::runtime_error("Invalid VPN prefix");

    auto addr = netAddress(ip, ipv6);
    if (network) {
        unsigned char bytes[16]{};
        inet_pton(ipv6 ? AF_INET6 : AF_INET, ip.c_str(), bytes);
        for (int bit = prefix; bit < (ipv6 ? 128 : 32); ++bit) bytes[bit / 8] &= ~(1 << (7 - bit % 8));
        char buf[INET6_ADDRSTRLEN]{};
        inet_ntop(ipv6 ? AF_INET6 : AF_INET, bytes, buf, sizeof(buf));
        addr["address"] = buf;
    }
    Json::Value out; out["address"] = addr; out["prefixLength"] = prefix; return out;
}
inline Json::Value vpnRoute(const std::string &ip, int prefix, bool ipv6, bool excluded = false) {
    Json::Value r; r["interface"] = "";
    r["destination"] = linkAddress(ip, prefix, ipv6, true);
    r["gateway"] = netAddress(ipv6 ? "::" : "0.0.0.0", ipv6);
    r["hasGateway"] = false; r["isDefaultRoute"] = prefix == 0; r["isExcludedRoute"] = excluded;
    return r;
}
struct OvpnTunConfig {
    Json::Value addresses{Json::arrayValue}, routes{Json::arrayValue}, dns{Json::arrayValue}, domains{Json::arrayValue};
    bool v4 = false, v6 = false;
    int mtu = 1500;
    void route(const std::string &ip, int prefix, bool ipv6, bool excluded = false) {
        auto r = vpnRoute(ip, prefix, ipv6, excluded);
        for (const auto &existing : routes) if (existing == r) return;
        if (routes.size() >= 10000) throw std::runtime_error("VPN route limit exceeded");
        routes.append(r);
    }
    Json::Value json() const {
        if (addresses.empty()) throw std::runtime_error("Server supplied no tunnel address");
        // OHOS uses all traffic as the default when routes are omitted. Explicit on-link
        // routes supplied by add_address ensure a split tunnel never silently becomes full.
        Json::Value j;
        j["addresses"] = addresses; j["routes"] = routes; j["dnsAddresses"] = dns; j["searchDomains"] = domains;
        j["mtu"] = mtu; j["isIPv4Accepted"] = v4; j["isIPv6Accepted"] = v6; j["isBlocking"] = false;
        return j;
    }
};
