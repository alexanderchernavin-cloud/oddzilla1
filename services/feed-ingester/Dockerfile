FROM golang:1.23-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/feed-ingester ./cmd/feed-ingester

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget tzdata && \
    addgroup -S app && adduser -S app -G app
COPY --from=builder /out/feed-ingester /usr/local/bin/feed-ingester
USER app
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/feed-ingester"]
