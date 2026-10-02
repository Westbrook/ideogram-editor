// Fixed reviewed executable/source-template authority, generated from held
// source data only. Eight compiler identities remain null and cannot release.
// Only this file's identity is an observed common source row; its path, all
// other common sources, executable templates and module pins remain fixed.
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const ALPHA_TEMPLATE_COMMON_OBSERVED_PATHS = freeze([
  "tooling/raster/import-seals/webp-alpha-template-authority.mjs"
]);
export const ALPHA_BASELINE_TEMPLATE = freeze({
  "kind": "webp-candidate-loader-reviewed-inputs-v1",
  "status": "pending-genuine-compiled-review",
  "commonOverlay": {
    "kind": "oversized-import-capsule-source-overlay-v2",
    "manifestPath": "artifacts/oversized-import-issuance-staging/common-v2/manifest.json",
    "manifestHash": "sha256:23eb193fcdaefe5fe1ac0f8766e3c89671d53746b0bfa19b6f059980a770ee3a",
    "manifestBytes": 12019,
    "requiredTargets": 17
  },
  "commonSourceTargets": [
    {
      "repositoryPath": "server/raster/import-inventory.ts",
      "bytes": 309,
      "hash": "sha256:59a01be9a7e5c7b9b7ba4267b810498f8c880537ab9ee2d37c073df47dde5f24"
    },
    {
      "repositoryPath": "server/raster/import-producers.ts",
      "bytes": 12154,
      "hash": "sha256:11f2a32c563ad621afdb2487d37a44f49e205a7f87157dae6d8b43d6d9088e0f"
    },
    {
      "repositoryPath": "server/raster/import-profile.ts",
      "bytes": 3462,
      "hash": "sha256:2acc589847c36764f0020176dcda8a9a09ef1fa30037cb01fbcd468fc39b4032"
    },
    {
      "repositoryPath": "server/raster/profile-registry.ts",
      "bytes": 8649,
      "hash": "sha256:b6cfd88d537898e31105d0fd43e206355e5a473c55228091c7bbbdd53c22dd0d"
    },
    {
      "repositoryPath": "server/storage/raster.ts",
      "bytes": 92106,
      "hash": "sha256:d726fa097414774035c3002cbc603248c0d642502086e37ee0f1dc1fd37f8c8f"
    },
    {
      "repositoryPath": "tests/raster/import-capsule.test.mjs",
      "bytes": 35621,
      "hash": "sha256:9dbe286b8630bdda4160bdeb668a9a3316d949bb2f343918e858a1f1ed690a78"
    },
    {
      "repositoryPath": "tests/raster/pinned-canonical.test.mjs",
      "bytes": 4496,
      "hash": "sha256:c81ff2843c2fc804becae053c24cff1ba2a3cf23872b2fb755a1ade1ea856ff8"
    },
    {
      "repositoryPath": "tests/raster/webp-alpha-baseline-template.test.mjs",
      "bytes": 10188,
      "hash": "sha256:b700f19795a6e06cd200097d4773d5d2a3f34b4a524d01f69fa01a2b7041bbfc"
    },
    {
      "repositoryPath": "tests/raster/webp-alpha-loader.test.mjs",
      "bytes": 8801,
      "hash": "sha256:0ab12113ce9b688abe0012bde07ec2378c533ab3706d6a2fe2c0ee042b6aaa5c"
    },
    {
      "repositoryPath": "tests/raster/webp-alpha-producer.test.mjs",
      "bytes": 3915,
      "hash": "sha256:ace985fc6b4eb57aaf3a67576fa344b5d4e3b5fc26c9bfefa3e42409a2f75b71"
    },
    {
      "repositoryPath": "tests/raster/webp-alpha-source-template.test.mjs",
      "bytes": 4055,
      "hash": "sha256:769f1d0419806be2041607d68a5bc64ad32c10b3b010d47672dc308984a3aaba"
    },
    {
      "repositoryPath": "tests/raster/webp-fixture-references.test.mjs",
      "bytes": 3280,
      "hash": "sha256:14348d9ad0d02666830c5439babc6070075ec4a1100ea57dfc2428a021a6224d"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/README.txt",
      "bytes": 5581,
      "hash": "sha256:7e0c1f43bf53f5f6101fe6761cf9ab9e590f4c735139e8460c1704d40c2b67ea"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/adopt.mjs",
      "bytes": 503,
      "hash": "sha256:b11bfe098c58da762c8ea6040983d26f7faf6758a86f95d3f10e673cb867ddad"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/authority.mjs",
      "bytes": 1501,
      "hash": "sha256:885d3262f5d0b346b4e7e99c500a06ec3380dcd3b19a11c5e3c34d7d9ebf21ce"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/capsule.mjs",
      "bytes": 20151,
      "hash": "sha256:1914a10a2cde03d72e4925ad13d9b4a5b755e087510a47e3237aaf2c09f17b49"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/complete.mjs",
      "bytes": 631,
      "hash": "sha256:e26a3b65e1b5aa248b859c64111eed3dc41c98d5f6d3db7456e3739491e1fc0b"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/files.mjs",
      "bytes": 5183,
      "hash": "sha256:78d7ddf74a9fc588f0eb06ee7c55d81ba624fe2887817a40a731a94d58ca9d3c"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/jpeg-gate-contract.mjs",
      "bytes": 7335,
      "hash": "sha256:7862d908f75482908edaf13362fc36865cf3cf7e06b1c4055e52e4919580c76e"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/native-contract.mjs",
      "bytes": 16662,
      "hash": "sha256:4f2c57e7a5792a43a867587fdeb2a9da9920496308ead3848f9b9a18323a8c62"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/native-webp-alpha-contract.mjs",
      "bytes": 16953,
      "hash": "sha256:e14115ed736bde2a6ad5b281b45011225f898a5560fa9c1a59ec20549a37d0ea"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/pinned-canonical-source.mjs",
      "bytes": 1781,
      "hash": "sha256:d4cf180d9c133e82d1f5f0f0d1503ff5adba7fada0d5f1a404a2f9e9098b188c"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/pinned-canonical.mjs",
      "bytes": 460,
      "hash": "sha256:7a740d6ab1454a7615a6ba9aff6d7b40d45ec26daaeebb2ee9aa7a88200c8296"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/verify.mjs",
      "bytes": 472,
      "hash": "sha256:91325d29b87c514de3a5d22303f25fae13d1015a39f0b4e30ea3ed7001cd9d32"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-authority.mjs",
      "bytes": 3510,
      "hash": "sha256:d2278265a8ef95fcb19e7f536226984302a8f5cb1b9c76726f1c64f4adbb7d37"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-baseline-template.mjs",
      "bytes": 10627,
      "hash": "sha256:acb5281d2fffb764937506d2630a5479aedeabd4e8c5f326f8ef2505a04a31bf"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-bundle.mjs",
      "bytes": 6798,
      "hash": "sha256:220d34f67660e52614b3c6ad31dd50843ebba44517531daf3cfef954f0072643"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-host-contract.mjs",
      "bytes": 31443,
      "hash": "sha256:f6e2af7250b014c97145f8fea86b10768e5067100474dee89059a27772217de3"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-loader-contract.mjs",
      "bytes": 18827,
      "hash": "sha256:937046e1889d725c8ad26859cf89fdefa067f6fcc558f094bfdf7124e312ef33"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-loader-policy.mjs",
      "bytes": 11316,
      "hash": "sha256:54cb32c72416997ceb07b3beab2ed4d5851ca7b57a45e8df494506630eb98b0b"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-loader-preload.mjs",
      "bytes": 2978,
      "hash": "sha256:7db06b2bdd7549ef398527d7ebf6f3df29ae2ebaaf0e2c3b7786111e3c7321ca"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-loader-runtime-manifest.mjs",
      "bytes": 7096,
      "hash": "sha256:b33b83bf37a91d2975e47ab85af76be44e749071a5fe78d1342f149448e0c7f0"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-loader-transforms.mjs",
      "bytes": 14777,
      "hash": "sha256:f55f65fd6657b8d5eee21e945eabc4af26b41c8fea58ac524c1ae805f3f4a7ad"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-native-children.mjs",
      "bytes": 3886,
      "hash": "sha256:343908893bb9285e0aa55f34e9217e79bb3172f795304208172172d717f281b4"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-producer.mjs",
      "bytes": 18405,
      "hash": "sha256:6e9ae885c5e674f33a906e81e1375b3430fb7c317e979503c3a0190e70089ee8"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-proof.mjs",
      "bytes": 10200,
      "hash": "sha256:043b749331e8294d7dedc58b00c51a50edabee8cf77cf14bb65ab9231d5500eb"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-resource-contract.mjs",
      "bytes": 13823,
      "hash": "sha256:85515784dcfcdcd4917282dd5876dd1064542abe20a56cd2aafc518b530d3f6c"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-source-audit.mjs",
      "bytes": 23746,
      "hash": "sha256:0a76873c7f61c0fbcbe7dae7f91a23dcf4b2ce809ec441ea09c5ddc55456a38e"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-source-template.mjs",
      "bytes": 4388,
      "hash": "sha256:0697f6c5e3b984a26381c3bd0bb66a0c96e131b5bdc56588f053d2232eb4bc79"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-alpha-template-authority.mjs",
      "bytes": null,
      "hash": null
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-fixture-references.mjs",
      "bytes": 1758,
      "hash": "sha256:e58f261cdcb96562978cbb75fb475b5b19104be9ad6719b6265b557d4aefe607"
    },
    {
      "repositoryPath": "tooling/raster/import-seals/webp-gate-contract.mjs",
      "bytes": 3905,
      "hash": "sha256:adf45133b79ba0f553dcfb8b81bbedc48a64639c6c6be4e32e05a461db33ba4f"
    },
    {
      "repositoryPath": "tooling/raster/verify-inputs.mjs",
      "bytes": 1757,
      "hash": "sha256:da16474a5bc5bfcb3c2cf3d52b3942a367f6a1515ca47237116278972333989c"
    }
  ],
  "compiledCapture": null,
  "modules": [
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/webp-import/tile-plan.ts",
        "bytes": 9259,
        "hash": "sha256:2126893fa7643c427dfeab20ad10059c14998563b95ea9ec1ce69399db0ef910"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/webp-import/tile-plan.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/webp-import/adapter.ts",
        "bytes": 19407,
        "hash": "sha256:bb3fcdb33cf602b10aef8b21b1891671b83b4a996b082510586d064a4deefcd0"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/webp-import/adapter.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/import-profile.ts",
        "bytes": 3462,
        "hash": "sha256:2acc589847c36764f0020176dcda8a9a09ef1fa30037cb01fbcd468fc39b4032"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/import-profile.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/import-producers.ts",
        "bytes": 12154,
        "hash": "sha256:11f2a32c563ad621afdb2487d37a44f49e205a7f87157dae6d8b43d6d9088e0f"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/import-producers.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/profile-registry.ts",
        "bytes": 8649,
        "hash": "sha256:b6cfd88d537898e31105d0fd43e206355e5a473c55228091c7bbbdd53c22dd0d"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/profile-registry.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/raster/inspect-original.ts",
        "bytes": 4190,
        "hash": "sha256:79e0e414170780ac9c856c29bbc024100aca0c1a6f8b8525e9982e9106fa8406"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/inspect-original.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "transform",
      "source": {
        "repositoryPath": "server/storage/raster.ts",
        "bytes": 92106,
        "hash": "sha256:d726fa097414774035c3002cbc603248c0d642502086e37ee0f1dc1fd37f8c8f"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/storage/raster.js",
        "bytes": null,
        "hash": null
      }
    },
    {
      "role": "guard-only",
      "source": {
        "repositoryPath": "server/raster/import-inventory.ts",
        "bytes": 309,
        "hash": "sha256:59a01be9a7e5c7b9b7ba4267b810498f8c880537ab9ee2d37c073df47dde5f24"
      },
      "compiled": {
        "repositoryPath": "dist/local/server/raster/import-inventory.js",
        "bytes": null,
        "hash": null
      }
    }
  ],
  "canonicalCorrection": {
    "kind": "node26-pinned-canonical-correction-v1",
    "manifestPath": "artifacts/oversized-import-issuance-staging/node26-canonical-01/manifest.json",
    "manifestHash": "sha256:488d0cdecd9373e126143af7ac8118d0343042a0c55ca906bda4f13de5e00979",
    "manifestBytes": 9649,
    "dependsOnCommonManifestHash": "sha256:23eb193fcdaefe5fe1ac0f8766e3c89671d53746b0bfa19b6f059980a770ee3a",
    "selectedTargets": [
      "tests/raster/pinned-canonical.test.mjs",
      "tooling/raster/import-seals/README.txt",
      "tooling/raster/import-seals/capsule.mjs",
      "tooling/raster/import-seals/native-contract.mjs",
      "tooling/raster/import-seals/pinned-canonical-source.mjs",
      "tooling/raster/import-seals/pinned-canonical.mjs"
    ],
    "excludedPngTargets": [
      "tests/raster/fixtures/png-issuer-source-v2.json",
      "tests/raster/png-issuer-evidence.test.mjs",
      "tooling/raster/import-issuance/issue-png-profile.mjs",
      "tooling/raster/import-issuance/png-contract.mjs",
      "tooling/raster/import-issuance/png-source-manifest.json",
      "tooling/raster/import-issuance/png-source.json"
    ]
  },
  "requiredSharedTargets": 43,
  "sourceAuthorityHash": null
});
export const ALPHA_DRIVER_TEMPLATE = freeze({
  "bytes": 10497,
  "hash": "sha256:395872605beca2703eb51d2c619efe1fa218c34efbac9b66da8bcabe655a8f87"
});
export const ALPHA_ISSUER_TEMPLATE = freeze({
  "bytes": 4632,
  "hash": "sha256:bd9a3dcc497aa37349b7d4db13f44d74e08e9f75b969b66e48274eb791aa7066"
});
