ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 build-essential xz-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY tooling/bootstrap-toolchain.py tooling/toolchain.json tooling/
RUN python3 -c 'import re,sys; assert re.fullmatch(r"ubuntu:24\.04@sha256:[a-f0-9]{64}",sys.argv[1])' "${BASE_IMAGE}"
RUN python3 tooling/bootstrap-toolchain.py
ENV PATH=/workspace/.toolchain/bin:${PATH}
ENV IE_LINUX_CODECS_BASE_IMAGE=${BASE_IMAGE}
COPY package.json package-lock.json ./
COPY vendor/en-reve vendor/en-reve
COPY vendor/text vendor/text
COPY tooling/raster/linux-codecs tooling/raster/linux-codecs
COPY tooling/raster/codecs.json tooling/raster/profiles.json tooling/raster/p3.icc tooling/raster/srgb.icc tooling/raster/
COPY server/raster/identity.ts server/raster/identity.ts
RUN getent passwd 1000 && chown -R 1000:1000 /workspace
USER 1000:1000
ENTRYPOINT ["node","tooling/raster/linux-codecs/install.mjs"]
