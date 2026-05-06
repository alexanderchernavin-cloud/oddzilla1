# Build stage — produces a static binary so the runtime image needs no libc.
FROM golang:1.23-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/signer ./cmd/signer

# Runtime stage — alpine + a non-root user. We need a real shell for the
# entrypoint that chowns the shared socket volume on startup; distroless
# would force an init sidecar. cap_drop ALL + no_new_privileges in
# compose still apply, and the binary is the only thing that matters
# at runtime.
FROM alpine:3.20

RUN addgroup -g 1000 signer && adduser -u 1000 -G signer -D -s /sbin/nologin signer
RUN apk add --no-cache su-exec

COPY --from=build /out/signer /usr/local/bin/signer
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

EXPOSE 8086
ENTRYPOINT ["/entrypoint.sh"]
