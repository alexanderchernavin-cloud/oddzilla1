# Build stage — static binary, no libc dependencies.
FROM golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/mail-receiver ./cmd/mail-receiver

# Runtime stage — distroless static. No shell, no package manager.
# Binds to high port 2525 inside the container; docker-compose maps
# host port 25 → container 2525 so the runtime user can stay nobody
# (UID 65534) without needing CAP_NET_BIND_SERVICE.
FROM gcr.io/distroless/static-debian12@sha256:20bc6c0bc4d625a22a8fde3e55f6515709b32055ef8fb9cfbddaa06d1760f838

COPY --from=build /out/mail-receiver /mail-receiver

USER 65534:65534
EXPOSE 2525
ENTRYPOINT ["/mail-receiver"]
