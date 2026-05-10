# Build stage — produces a static binary so the runtime image needs no libc.
FROM golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/metrics-collector ./cmd/metrics-collector

# Runtime stage — distroless static. No shell, no package manager, no
# busybox. The container runs as nobody (UID 65534) so even with the
# host bind mounts the process has zero ambient privilege.
FROM gcr.io/distroless/static-debian12@sha256:20bc6c0bc4d625a22a8fde3e55f6515709b32055ef8fb9cfbddaa06d1760f838

COPY --from=build /out/metrics-collector /metrics-collector

USER 65534:65534
EXPOSE 9090
ENTRYPOINT ["/metrics-collector"]
