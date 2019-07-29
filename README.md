Requirements:

- `brew install swift-protobuf`

Instructions:

```sh
wget https://download.libsodium.org/libsodium/releases/libsodium-1.0.18.tar.gz
tar xzvf libsodium-1.0.18
cd libsodium-1.0.18
./dist-build/ios.sh
cp -rf libsodium-ios/lib/libsodium.a deps/
rm -rf libsodium-1.0.18
```
