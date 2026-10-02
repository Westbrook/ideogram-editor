# Supply an immutable Ubuntu 24.04 image identity. See README.md.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ARG SOURCE_REVISION=working-tree
ENV DEBIAN_FRONTEND=noninteractive \
    QUALIFICATION_BASE_IMAGE=${BASE_IMAGE} \
    QUALIFICATION_SOURCE_REVISION=${SOURCE_REVISION} \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    CI=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 build-essential pkg-config git xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
# Keep dependency and browser layers independent of ordinary source edits.
COPY package.json package-lock.json .npmrc ./
COPY tooling/toolchain.json tooling/bootstrap-toolchain.py tooling/verify-vendor.py ./tooling/
COPY vendor/ ./vendor/
COPY src/text/profile.json ./src/text/profile.json
RUN python3 -c 'import os,re; assert re.fullmatch(r"ubuntu:24\.04@sha256:[a-f0-9]{64}", os.environ["QUALIFICATION_BASE_IMAGE"]), "Supply an immutable Ubuntu 24.04 digest"'
RUN python3 tooling/bootstrap-toolchain.py
ENV PATH=/workspace/.toolchain/bin:${PATH}
# The prepared packet contains only selected historical Git objects and exact
# test fixtures. It never includes the checkout's Git configuration or remotes.
# Verification is offline and refuses absent, changed, or unlisted inputs.

# Installation uses only the sealed toolchain, package lock, and vendor inputs.
# These build stages need public network access; the test container does not.
RUN npm run verify:vendor && npm ci && npm run verify:vendor && npm ls --all
RUN npm exec -- playwright install --with-deps chromium firefox webkit \
    && rm -rf /var/lib/apt/lists/*
# Process ancestry is required by the correctness/timing exclusion lock.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=10001:10001 . .
# Cheap source failures precede historical fixture installation and runtime work.
RUN npm run typecheck && npm run test:preflight
RUN node tooling/qualification/container/inputs.mjs install
RUN mkdir -p /home/qualification /workspace/artifacts /workspace/dist \
    && chmod 0700 /workspace/artifacts \
    && chown 10001:10001 /workspace /workspace/artifacts /workspace/dist /home/qualification \
    && chown -R 10001:10001 /workspace/.git \
    && chmod -R a-w /workspace/.git \
    && chmod -R a+rX /opt/playwright
ENV HOME=/home/qualification
USER 10001:10001
ENTRYPOINT ["node", "tooling/qualification/container/run.mjs"]
