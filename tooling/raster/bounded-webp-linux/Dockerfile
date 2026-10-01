ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG BASE_IMAGE
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 build-essential binutils xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY tooling/bootstrap-toolchain.py tooling/toolchain.json tooling/
RUN python3 -c 'import re,sys; assert re.fullmatch(r"ubuntu:24\.04@sha256:[a-f0-9]{64}",sys.argv[1])' "${BASE_IMAGE}"
RUN python3 tooling/bootstrap-toolchain.py
ENV PATH=/workspace/.toolchain/bin:${PATH}
COPY tooling/raster/bounded-webp tooling/raster/bounded-webp
COPY tooling/raster/bounded-webp-linux tooling/raster/bounded-webp-linux
COPY vendor/raster/bounded-webp/1.6.0-ideogram.1 vendor/raster/bounded-webp/1.6.0-ideogram.1
COPY tests/raster/fixtures tests/raster/fixtures
ENTRYPOINT ["node","tooling/raster/bounded-webp-linux/build.mjs"]
