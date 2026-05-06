FROM golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/wallet-watcher ./cmd/wallet-watcher

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
RUN apk add --no-cache ca-certificates wget tzdata && \
    addgroup -S app && adduser -S app -G app
COPY --from=builder /out/wallet-watcher /usr/local/bin/wallet-watcher
USER app
EXPOSE 8085
ENTRYPOINT ["/usr/local/bin/wallet-watcher"]
