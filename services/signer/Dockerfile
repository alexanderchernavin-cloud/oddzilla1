# Build stage — produces a static binary so the runtime image needs no libc.
FROM golang:1.23-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/signer ./cmd/signer

# Runtime stage — distroless static. No shell, no package manager, no
# busybox. The compose entry runs the container as UID 1000 directly
# and the signer-socket tmpfs is pre-owned at that UID/GID, so we
# never need a chown / dropper-entrypoint shell — the binary is the
# only executable.
FROM gcr.io/distroless/static-debian12@sha256:20bc6c0bc4d625a22a8fde3e55f6515709b32055ef8fb9cfbddaa06d1760f838

COPY --from=build /out/signer /signer

USER 1000:1000
EXPOSE 8086
ENTRYPOINT ["/signer"]
