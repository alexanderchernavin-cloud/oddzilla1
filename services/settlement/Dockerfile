FROM golang:1.23-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget tzdata && \
    addgroup -S app && adduser -S app -G app
COPY --from=builder /out/settlement /usr/local/bin/settlement
USER app
EXPOSE 8083
ENTRYPOINT ["/usr/local/bin/settlement"]
