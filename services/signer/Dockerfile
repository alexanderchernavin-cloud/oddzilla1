# Build stage — produces a static binary so the runtime image needs no libc.
FROM golang:1.23-alpine AS build

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
FROM gcr.io/distroless/static-debian12

COPY --from=build /out/signer /signer

USER 1000:1000
EXPOSE 8086
ENTRYPOINT ["/signer"]
