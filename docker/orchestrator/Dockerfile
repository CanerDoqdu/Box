FROM docker:27-cli AS dockercli

FROM node:20-bookworm-slim

# Use modern Docker CLI to match Docker Desktop daemon API levels.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /workspace
