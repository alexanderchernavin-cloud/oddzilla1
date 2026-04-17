FROM golang:1.23-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN CGO_ENABLED=0 go build -o /out/bet-delay ./cmd/bet-delay

FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget tzdata
COPY --from=builder /out/bet-delay /usr/local/bin/bet-delay
EXPOSE 8084
ENTRYPOINT ["/usr/local/bin/bet-delay"]
