## Rebuilding protobuf

```
brew install swift-protobuf
protoc --swift_out=. VowLink/messages.proto
```

## Installing dependencies

```
carthage update
```
