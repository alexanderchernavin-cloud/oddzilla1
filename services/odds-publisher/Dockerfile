FROM golang:1.23-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/odds-publisher ./cmd/odds-publisher

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget tzdata && \
    addgroup -S app && adduser -S app -G app
COPY --from=builder /out/odds-publisher /usr/local/bin/odds-publisher
USER app
EXPOSE 8082
ENTRYPOINT ["/usr/local/bin/odds-publisher"]
