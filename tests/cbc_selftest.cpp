#include <cstdio>
#include <cstring>
#include <mbedtls/cipher.h>
#include <openvpn/io/io.hpp>
#include <openvpn/mbedtls/crypto/cipher.hpp>

int runCbcSelfTest() {
    unsigned char key[32]{}, iv[16]{}, plain[1536]{}, encrypted[1600]{}, recovered[1600]{};
    for (int i=0; i<1536; ++i) plain[i]=static_cast<unsigned char>(i);
    // Reproduce the old adapter: setup/setkey/reset without explicit padding.
    mbedtls_cipher_context_t old{};
    mbedtls_cipher_init(&old);
    if (mbedtls_cipher_setup(&old, mbedtls_cipher_info_from_type(MBEDTLS_CIPHER_AES_128_CBC)) ||
        mbedtls_cipher_setkey(&old,key,128,MBEDTLS_ENCRYPT) || mbedtls_cipher_reset(&old) ||
        mbedtls_cipher_set_iv(&old,iv,16)) return 1;
    size_t n=0, tail=0;
    int update=mbedtls_cipher_update(&old,plain,17,encrypted,&n);
    int finish=mbedtls_cipher_finish(&old,encrypted+n,&tail);
    mbedtls_cipher_free(&old);
    if (update || finish != MBEDTLS_ERR_CIPHER_BAD_INPUT_DATA) return 2;
    std::printf("PASS reproduced old CBC failure: finish=%d\n",finish);
    for (auto alg : {openvpn::CryptoAlgs::AES_128_CBC,openvpn::CryptoAlgs::AES_192_CBC,openvpn::CryptoAlgs::AES_256_CBC}) {
        openvpn::MbedTLSCrypto::CipherContext enc,dec;
        enc.init(nullptr,alg,key,MBEDTLS_ENCRYPT); dec.init(nullptr,alg,key,MBEDTLS_DECRYPT);
        for (size_t length : {size_t(1),size_t(16),size_t(17),size_t(64),size_t(1500)}) {
            n=0; enc.reset(iv);
            if (!enc.update(encrypted,sizeof(encrypted),plain,length,n) || !enc.final(encrypted+n,sizeof(encrypted)-n,n)) return 3;
            size_t out=0; dec.reset(iv);
            if (!dec.update(recovered,sizeof(recovered),encrypted,n,out) || !dec.final(recovered+out,sizeof(recovered)-out,out)) return 4;
            if(out!=length || std::memcmp(plain,recovered,length)) return 5;
        }
    }
    std::puts("PASS patched CBC: 15 encrypt/decrypt round trips (AES-128/192/256, packet sizes 1..1500)");
    return 0;
}
#ifndef OVPN_EMBEDDED_CBC_TEST
int main() { return runCbcSelfTest(); }
#endif
