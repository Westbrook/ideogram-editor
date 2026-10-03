import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// One current source-review tuple, never a compatibility table. The native
// preview/Apply and private event witnesses still establish individual sites.
// This exact corpus bounds their call/escape census; changed or additional
// application code requires a new finite source review before any exclusion.
const reviewedRows = `
index.html 881 2a5f972699a6c978cf2444720572542fd616f5e9741c614d1f567f44517a90a0
src/adapters/profile.ts 5995 ccf144b64485a45f6188334947fbde9fa932e5bcb4ddb29a89b8de33ed13590f
src/adapters/structure.ts 7417 fd16dd585940450b95e3106eb14973111cd71ea10cc8fe06c9ec50351a3b33a7
src/composition/core.ts 23205 6fba62d8f28ecfad1469fbb4e9f29d9c64eb8e42a647452ea2abc0c155d2f5a5
src/composition/draft.ts 4951 b544c10527e482822676ed4c5c1a06b226b5ca688835932fed454868c4b2318e
src/composition/memory.ts 10016 f528c9ef6bd1ff53dab071d4ebcfc4cb726404f494011de27bccd31476c1e391
src/composition/text-export.ts 9739 5c4f6491e1d6ac67f68390d5b9d2471d9753b782a5c1a883cf72fd5bca328f20
src/composition/view.ts 506 8b784acc9948ca8a519ef415722668834ee454768cb67c1fd555013b21a7b930
src/main.ts 964 d185215040eaa0675747b0da9de615683abc0c99d0d228b9590821d668a4febb
src/observability/adapter-upload-hook.ts 1214 756a93d71aff8092d41c9eefa8ddabbe5983acdcc2f5350e958b3b263db8ceb9
src/observability/adapter-upload.ts 13589 77d8bc7603e9a7db0df09369078b02381bca012c92c30c7df1a3b014b198dbba
src/observability/allocations.ts 40091 31a220cd0df3df7577212c64b5e5db3a21c16dc3c95de99f77721c4c6e77ac06
src/observability/browser-worker-observations.ts 3117 00cd9c0b7e19f8a72878d92d31dd79b3578a49df24023b25b2acb343bb8300d2
src/observability/browser.ts 21101 bf2d6fa12ae6de9e8d13405574643e664b32fed12ff57d697b6eaacd9c9bc2a1
src/observability/composition-observations.ts 16019 966cf50aea8c77470a0dad9ffc08accf03ae974f99bb05292b1cefe23de93cfc
src/observability/diagnostic-memory.ts 7157 1c0fb3ff0c1ea0e346106d84ca6f561cf1a097fb1ec355f96ff49429318d27cf
src/observability/display-control.ts 1647 455f5f15d48cac494525de9817ee685db8f476a4161e9887c10eca7f26b8f0a4
src/observability/display-preview.ts 20859 938f3ea3c85c2eb491b4629c4840d107f0d60e2ffe7ed5315b4b5c2414231b8e
src/observability/display-scheduler.ts 2969 0a41dc42a8fb9e17efd36d53a3c4f54fd79944473300e11c7349859bb6d2efae
src/observability/model-memory.ts 5243 79d5f368134a38dcc01abdf29d42bff9840c4f42d6e3f8aa3c83864d5e58f118
src/observability/navigation-observations.ts 5156 ddcbdfec01b890238fde7a9d33f4843661264aa375a8d3660e4608a239c58490
src/observability/owned-preview.ts 5274 0bd894009708bf330aea1c7d217a1e1a0ee5e20aa8b474a366f6a8f0987ea762
src/observability/phases.ts 10214 b50dcdadc22f9fbdbbbf6a19d9f453b60a5af94a3dfc17da9990503a81bb265b
src/observability/prompt-memory.ts 6877 65d2bd5efb45197f2f4edecbcbde7b40f0fc65acb278fde42e02f57146eb30dc
src/observability/recovery-memory.ts 6093 52c4b1f97ae3ee5e3eec4e88ca0274174aaea1b54f611ec27a948393f052b492
src/protocol/adapters.ts 10834 49cff659b62eeb5ba4df9c21ba589aba60bb42a887734523edcf255db42bf51d
src/protocol/asset-projection.ts 1312 49db7085d8cb0626cd22dba2b87f585b867be8ba6cb101efecbfe54187cd0931
src/protocol/assets.ts 2837 4e80ddb80e6244f8c30cec7272185fa6548a3ac2c0f5a5172d93cd5684130724
src/protocol/candidate-placement-review.ts 6833 dcca33d598d7de3dc6732cfbab57c9104e5f783c9f7c7fb60542bcc2dac5dbfc
src/protocol/candidates.ts 4080 3452fe398348f40a1c321931ad013b1c4147ccd898c4c976f9e763ce34d5b91c
src/protocol/deletion.ts 893 8eaf9365f73bc56022476de004b4411a76176645029202407dc5baa3a96e3557
src/protocol/display.ts 2630 28c738c8080ff9765f937b5a312f58be8785c610b9c52a306addf53823963f5e
src/protocol/document-creation.ts 2150 d281fd9fe57717bde67c4db75026972090c3b36ac16119682fc073b648b4c311
src/protocol/encoded-rebuild.ts 6540 d6abc810868df34b1cf4aa495baed7d11e255b37c0075e2c25e93f426f839f32
src/protocol/export.ts 1750 bea072e2d3a6ff5cdc0308da33daca529a40ba4ffcc285570543622e2c9a5b5f
src/protocol/history-validation.ts 8071 110fb9cfeb47182bf48d4959e51b987488d2a230ffc801dbab84b1bbff9659e7
src/protocol/history.ts 8792 c31f9c89237f6f1d40b1068b3fc447a3853a0d6fd478b8f0b652538b4dceaeb7
src/protocol/json.ts 4337 2c7c9fd87dd2312bd144418a8ef6239e496c556c435c11eb326de5aa42f5b7c4
src/protocol/portable.ts 3500 c3788b41d0ab977590f0a22df0f533b364384c57b8dbec2ae76529c7548fb6fd
src/protocol/projection-schema.ts 3544 f6d7e8de3b2e7636335fcf87936fe3ec91d1a6fd52f4f11721754c4a7a53ab1a
src/protocol/provider.ts 2379 48a05e2bd47d9afc606aa608d1ab96268dca74d52beb39cf347f95d15907c296
src/protocol/queue-events.ts 305 cdc923af08d68ce5bd260a2128a92c91dfbb75f2e3dcd593bceee8e22108e545
src/protocol/queue.ts 4678 7e29a16bdd3459d70611eb44f7f9813e4a06b87b8b64cb95c3ab9a2141012282
src/protocol/raster-import.ts 8151 e6216dc80bbc31a66a559a1d13adfae6580a4f8899ad60332ac447787ac7c86d
src/protocol/raster.ts 2620 4908943e55c50e8ce5af54f9d86de9b5faec800e28de39a69d8c5c25317f7b86
src/protocol/recovery.ts 2964 7fc1be8bf95007250a6fb6942c999170c88460f02db56cf01450d393dc4c7f7c
src/protocol/request-edits.ts 1980 5eef93ccfc9f3ac930301ba13ca2779b5ce3b3f3e14e06901d28cd263fc9453f
src/protocol/session.ts 1646 2e3f10e47615fdfee3edaca39f8f7ccfa86635094de4a9f787d45c28f26e1ad4
src/protocol/sha256.ts 2672 6125bfb8366910293774bd3efb05edcbc8f37fddd3642d6c43a7921ed0e73684
src/protocol/storage-repair.ts 3715 d07414e14b3cfb5f0648a79ee02058b2639cb4bf21066a0f212857a10ed6582c
src/protocol/storage.ts 9085 9fe7a525099ab25fb12a0ba4aa7e1655fc24ca50eceaa96bf8c3f0a4aad15df4
src/protocol/store.ts 3628 f8fd2bdee1da82c4c8f4bbde51c50f186ac06b40da079330f76511ad5863930a
src/protocol/text-budget.ts 5405 cca773c4442c8a1ec218c11c2344ff8e2811067ee8b10e48fae1c0aba85db590
src/protocol/text.ts 11601 cee1e8e4a1cf2053ba0d14a58f6ea4200ff5bce36da657fa54ab34b342472abe
src/protocol/ui.ts 2104 bfbb2b10abfef1ea423751dba691e185ded9618d944ca0614846e23c8039c8d5
src/protocol/v45-inputs.ts 5738 e72fae2dbdaed62bf64588db0cbeda80e3971a805a5a10914ca8cddb6e6fa84b
src/protocol/validate.ts 33128 e330cf3ebcfb4ad3482d642ff029b3b6b07c0a319f782bced20621a21f777e38
src/raster/core.ts 8804 d8de114ca50149e77c02c5cb5fa5b17b38f2d56cc6933db85a19242c6cd168b3
src/raster/mapping.ts 1899 b642fac2ac9a0864bb1d4deaef4a31243c5ad1e21adc26aaeeab158c50f87156
src/raster/mask.ts 9339 7b1fa5636a925c7b6845002a2c862cf3a2c30efbc534cec66baba2f7f7d5e47c
src/request/core.ts 29030 1047aa48fe5d1e7d2af795aa3b05f1b27a8a15c1f987e8b2e582557d6a61deb9
src/request/family.ts 9739 77f824dcba1464784d6c39ca3e05fd78a9d9c18e6be0657344ae672a0b38b4e0
src/request/raster-plan.ts 26419 3b1b7cbbbae5b42907614d8b05d623653cc44454e92b679696310f0e471a50dc
src/request/review.ts 6237 7dfc05b8eee3d434b94ba74177c465855563afc2f1c371c8e6dcfd57b1837bb0
src/request/text-treatment.ts 45353 2ab56b85fb685b72a0218b8d00110aab19d32c5a67e572bdb65914c85c52de9d
src/request/v45-edit.ts 15680 fae51b0499780c5fae51d540e822a7871768a32d689f11b13b2be2c1d2f608f5
src/request/v45-family-edit.ts 11475 d971b8173a06ef55dead0e084dd8daa0fbf1154e04fba692fe8d3803c4b97c44
src/request/v45-prompt.ts 1619 bb584866ec006afcabb9081ad39c50f59470a832a330803b8b745f5bfa4c3452
src/request/v45-stages.ts 1622 f2b093d6b930ce1b191051fce4e362916f98d6033d7d7cd437e09f1b5724fdd2
src/request/v45.ts 8473 d7cc0c18f7b8c8cda92beadc89f78aeceee13c015b62c75d869c39f2ecc56bf8
src/state/browser-journal.ts 4709 e6b6a51bb724608f1ccffe5c6ccbfe277e9d7b366e9523be00f73f6bc334011e
src/state/command-results.ts 15408 b771ee97323f8393f0eea83998af06e733bfd7349b902f63b4abf32a63ea9b4b
src/state/control-memory.ts 3960 80b1f564855ef58462d44a708fc211770ed73f481ba44f71db13fdef75716d75
src/state/destination.ts 22122 d1c6644511370e65f549ec04b0a392d2b2f60a35dee1deb2d2e568b0fe454222
src/state/document-lifecycle.ts 1760 1cfc86cc3a7f5bca57bbe531ec5cb99d47b3bc99c90a283df2aeb62cc79f0fed
src/state/document-list.ts 2519 430d0ebc556bf305896d4b33ec9ed58d2bc576f433e66c1972d53299afbcab72
src/state/draft-persistence.ts 21470 677621bcddf8c2edebd9ba703552db3d3e41062a38e22e050dd7c0fd09060bdd
src/state/draft-values.ts 11215 9c8c592ed3d3374728d33cb8b6bd274a96f5b21c4d929f09c30657c32cb295d1
src/state/editor-client.ts 132260 86e0d989d26095161a307ddc493a1913a10735a2d6c5d6fcb1f0e40c62c820e1
src/state/export-options.ts 2632 9e4064cb4d4b37c8e0173d6c4020e6bf8a05aa8e999571f32e801ac9bb72f1f3
src/state/history-availability.ts 1318 51b1c63b3959a18fccfef51662cd974a01eb3ee52070f6a5eedbcc4eff671e5d
src/state/idb-ownership.ts 7990 bad165b4193384168a9f0cca3f265796c8389885a5fc1446351dc1452b981291
src/state/keyboard-preferences.ts 544 64e4db9f76cce85cf501fb0da6f670df94e70bd8ddda25b7771729c75059dd01
src/state/projection.ts 2058 9cf86f8a121bcef8b07879405d5989189df615684b46aa64185da9e0cb0b63f5
src/state/queued-replacement-fence.ts 3345 d401f3df1f7b6b92990c52dc0492e48046fea53a46e18ed11ad8607a05f3f5d5
src/state/recovery-cache.ts 8215 6171ea3ac2b90d73c7bb7e80963fd272a625f678aea2aed75b3de64aa7dd825f
src/state/recovery-client.ts 24263 faf5498835f4de89d0bac8126c72f7e6900883ef0387f5f52753e865408314dd
src/state/session-client.ts 10034 7d134699839c9c260022e736260b8581931d07a8b44d5cac06882c3f702a386a
src/state/view-models.ts 14633 43e59ad5ae379bf48d6cf6e83a7829e411672d83fc20e471d52ab1e81a486509
src/text/admission.ts 4357 be0ae31c17e9d0497a27a49d0b15f1be7672c20c5752e8423ad71f0f06fc5e1a
src/text/bidi-data.json 19070 df36e677252814e1d84009c9ab735c12ac67deb7460695d64b477beee00b955a
src/text/bidi.ts 632 9fbc954b46188247d44c829ce82bba259de40dbcbb0100380c43aa8e7b961350
src/text/bundled-fonts.ts 1857 14772cc968adf2512319ee2be18062db6b8ab32a591e1c0bdc3efe0305494c84
src/text/client.ts 10443 797c8a655b93bc9991b33d9f11c8ab694f868ea7a5c83625f6a1e5472ed297d4
src/text/contracts.ts 9434 08207c5aab6d234ac693fda1d8a0e4f3542bf446d67fc0b8370a5d8b9b024ca3
src/text/core.ts 20578 ba210ea0538daab09ded2d4013b1e5eb4948c47cf935afcdc6acd0ef707a7003
src/text/durable.ts 9424 6b426048f78f1a95d8a23c9b4e7724ce2774e7a0cc47bea8968b4258a2682d52
src/text/engine.ts 1476 c86d782ccb92de17fb4a01376e16989b13114156abcd6418a011af43efb5c830
src/text/font.ts 4272 76a715d1e84212ae66dcbe34c55ae8a879e473bfea299987018a7d7bd9380b01
src/text/layout-writer.ts 5701 2edb8376e51f8988af0dbb3fdce5789b0c22a2d236835e5e651ca918255477ea
src/text/memory.ts 8104 7c2e1c7a90f053ee6ce26898bded8988bcfdc8c7e2abc8086170bc0d9cf81c7b
src/text/profile.json 19566 96a0b022708ab52c7865b1e784d7c5363627473ba2b87adf0a9cb6bf033bf36a
src/text/retained-profiles/1c399d52.json 18008 140b72169cfae3e5fe727f58a0395b3a21ec7da6cf36283e87c9320a6a6c6ee8
src/text/retained-profiles/2e9362c1.json 18885 acd1585535b30b39843af8615e2a40f95291b178a167e40535bea16528918427
src/text/retained-profiles/304528c9.json 15748 13f8dc3e3cbe8b7f572b2c624068a7cbdf683a04bb91a3de87a021621e030033
src/text/retained-profiles/4fd6f6a1.json 16958 3b5159888dd22ea25a4a660bc36f788e13eb526db558bb72e6bab44aedee7dcd
src/text/retained-profiles/68efa85f.json 17134 ea257991e81f2a1ebe4f2c3172c6071628b1a30b4230a5ec7c9b92d35db6c99e
src/text/retained-profiles/6d77f925.json 17478 a00135bd564fa7926b97752024a1a00ec7c23ba520f4aecca63b74ad1cd2e599
src/text/retained-profiles/6e8a481e.json 15396 15634d19418bc21841fa8093de2ae7598b752c2f158be90f6e7e06216d79d6da
src/text/retained-profiles/6f7be5be.json 19214 c631086528d51d967a6a692777ff8fd5004ddf410e47b003f3ef7cbd0311a4bf
src/text/retained-profiles/7a4dbc6c.json 16782 808650b42cc817012dd5d68df0124171ac78679ce497acd6a6c031409886052d
src/text/retained-profiles/891a4688.json 18360 f7c063fd77161f6be59b2a20559ddfda42e4bf8fcd2d04297d7321d324232a17
src/text/retained-profiles/95244362.json 19390 96403bc29e02fc5e5162a6dbff1ef1387f2d892df9021b74efc2b625f5dd515e
src/text/retained-profiles/b89503d3.json 14238 39b0190db275a08547f01494eb3f2725cdb7d2d3cb7a8e92abe42bbae6c5dee8
src/text/retained-profiles/b96236b0.json 18536 0c2857d4033926a7db23957fd3bf002929aa33a201e059626a9f8f286227d288
src/text/retained-profiles/c19791ae.json 12986 80d5dfb1f0f89548969c97348b57d0ddc6e8098f719de97dfb9feb9839734d2b
src/text/retained-profiles/c6ca02c2.json 17655 d3ef40a7cbf8b4119627dc2f4ce1a11cb1bb1c9eedfb6b9d8321e04afeb249dd
src/text/retained-profiles/d047f5be.json 15572 d2cd5204fa8822a0ae17f610ada9add6b083ab90097d16b14397193522f54b1e
src/text/retained-profiles/e648eede.json 18184 1015d4832862ab35edb4fe9010d129d88a8d2fe4d1cefae4ffbe63054e62a6e5
src/text/retained-profiles/f5e8bd34.json 16101 2b874883288b0e197153220b4e44ff1dcb751d34c164a3f558668b40733e7d3b
src/text/retained-profiles/ff24a513.json 15924 82bbff0efe60f4633875efe51917e9526464a2ddc54ab28c2dc048d44267ef36
src/text/returned-description.ts 9029 4c20cc4152f1c6777d73a92623cd2d8f0467dd9660f2a13d1ef7e189333e8c40
src/text/split.ts 3841 19b7c1b5a41f920f51d163e2cc3d2ecbf05459471554b36f001aee171016590d
src/text/worker.ts 2089 7f60b4d87d0557bbe79e3472d643c6fb233ddbfe4923e7738e823fde86fe38be
src/theme/appearance.ts 676 c35f3badddd70240e30ee8198e7353f0dbb4c9020afcda9380b6e23f7996d787
src/theme/density.ts 1236 26cf58af3eb0a582f4b51397ecd18bf5bcdc3f83176a410728e440be5525950b
src/theme/shell.css 28334 47412ebe81d5e5dcdba9e807f6639f7ad35566bd8a2ed8f1bdfeff9deb6b6c3e
src/theme/spectrum.companion.css 27494 58c83bba8e5560b838a1b822ada08adab200be353ce7ba45be6756fcd88e45be
src/theme/spectrum.css 49741 ca1216ca1efc6dd6c99be79b94a366f95939f593bb13eeec73fd5b0b84e6444b
src/theme/spectrum.density.companion.css 58517 83d713adb38f1114fa4f18c38e3882c81240df56ddb42142f95e914c51e3565b
src/theme/spectrum.density.css 99593 0f9d2b4d8a0cc498e73b29dcda5c3990b973d028f4cab58055dc4c953a76284c
src/ui/adapter-library.ts 52982 c36e5c21aa53d940b7fe0507a81185eef5525bb5ee628bb59b9d2a4b91ad366e
src/ui/adapters.ts 1338 8a3a2476552dba3e8bd33b6d1bbc35e7b6663472e92cbe7999e5409f105b7514
src/ui/authoring.ts 65513 96eee099eb24452775f166b7c604ac9d46f23ebd2f7c53a2d686045b563d5b53
src/ui/candidate-comparison.css 1614 acea87503cdcb9135eda4c9dccd532596ca05810d10b5b6fd5b4d78ee8f5384e
src/ui/candidate-comparison.ts 12975 7343f2ac9a0e23d7acdd76a5c13be86113ce319f97d529b3a0f5ac2ab6fcee9c
src/ui/candidate-selection.ts 1972 77450803a9a542d5eff9518c42bd219a3881162f5499654082233fccddfa4136
src/ui/candidate-text-treatment.ts 22157 298b25ec1aca29a179432a34d617d7a0cd900a9dfe1879cab08adaba00671125
src/ui/canvas-view.ts 23346 69e5d914e0b783e0e1bd39a9570cd0f840ee287a8b7b261e3a4df08759fd04db
src/ui/command-search.ts 11251 105d950b9cc16e35f70a4482ced6183d3599ee9ab6ba7e38be72158e0dd543ec
src/ui/comparison-view.ts 8320 f692decf866069b8cb09101b18dc28512d97e32ddf7b06513b9261fa2ac665c3
src/ui/comparison-viewport.ts 2313 66881c5d3b8a7db109d47f75aae2d46130912f9adfddc37d9f5a08513d17cdf9
src/ui/composition-lifetime.ts 3633 2d33911edae29aace3d0e28fbd3b3037408c5d07fb15e357bbeee6499ff1438a
src/ui/composition.ts 72688 78b3938609555f581fecca318b16f06f9a384c9ed62791996b6214badf877f80
src/ui/deletion.ts 17476 c44d524b1fa34e388bbf9c3752a2fa017d45d902eb87f78c74e9f10b4a63641b
src/ui/dialog-ownership.ts 3550 2d73cd25c25542b1a07ca870431e92831bbbe8ef9d9e825f4bea02ae028a6101
src/ui/display-image.ts 2275 5a4f4b2206f8c79cc1e3804d3756760f073a1e24d9d34774a6e1988961af6eea
src/ui/display-tiles.ts 21376 1227c3d78426138eca9f99d174b5b55f1866db45963a7fed75f9bccb48033092
src/ui/editor-panels.ts 222 317eb7d341385707685a0051b0a0f845106b90216415d784ba37147775633b29
src/ui/export-memory.ts 4385 2f64b75340851239a90d8b5baad68b7f1f48171bfa42d04d087385eda6207330
src/ui/export.ts 29218 cfde6a3159485b3436f80571839fa7235109f5239baf38488812a42331bb175f
src/ui/font-relink.ts 795 f01c60678b5c2228b310b3b381d0fd4fed163ca255e1d03ed73c939f72760a89
src/ui/icons.ts 1127 71ce0b0bf30ad2ead51133eb6cfd6d2866f05c6af3ba656fdae8f0ab91eff6f9
src/ui/image-import.ts 39682 967bce89ddcba2922730a0ac1be42df2dd4880bd04d3886238cc4f9b692c7584
src/ui/inspector-model.ts 6018 e90972c20a71cecbc1e48fc9f66aaa8da5293fa636ac510a008e300dd226969f
src/ui/inspector-transform.ts 3730 5deb71bb46fd6b2b9cc72b22b230772049d560007701d8eb2b7ed4e426c92c9d
src/ui/keyboard-scope.ts 2505 e2f4a3c60a4939ea34aeae97b2fd14310cb97d8d00586c0d3cf72abe6cf079cd
src/ui/model-owner.ts 5793 b6e6daa3fc7ec66dc5f5e6a8f193d6d395028326f739a2802bb8e18232346524
src/ui/native-control-memory.ts 3643 b8b811e36e6b73f27d01a2a412a657010809f7f8a43923c6bfb02b9a458d18b3
src/ui/native-text-preview.ts 1165 9d22637412b77397f650608d1494ccab5367015ca61ed2d70464ca26475c65d9
src/ui/native-text.ts 107073 2cf4f6d756cda567a9b8eb801d1ac0d493e01a1af6f1b06ea75d37d4c2ca777a
src/ui/new-document.ts 13476 d1ea4f98e67bacfd65fc1f1003e2dff920653c6436edf7377a5f778185989419
src/ui/provider-payload.ts 4230 a100964fd08b21515369099dc3fafa851f209177e7826c1dd25d12f930044368
src/ui/provider.ts 19559 cbf18fa6031136a1f802c9a12a8a259389831cd488b3c75d00aca7542cfc8f17
src/ui/render-models.ts 1966 2623824d32f272039dae67ec047622079f4e25c4f01954494ee361b6ae78b9f9
src/ui/request-composition-text.ts 7915 7d06fbadfddea5bd716d8496362b780d38598885806047e145cad42d28e4da6d
src/ui/request-edit-models.ts 8234 5c6c04aac0972f4c67dd5b3f16aabcb510ce4a64da83af410aca58b9cc479514
src/ui/request-edits.css 1715 37bdaea25e0c49f5ae97136d852e2623099b942ee6fdeccfbc09e3c59668b73a
src/ui/request-edits.ts 137286 542adfbc5157a48328f4d24066ebf9abf9e498755243a2a4f4b1d3710e92f35c
src/ui/request-entry-memory.ts 2129 830a6cba622d2d11486590e2cd478095f9ad9334b8182d83a23cb96e78d196bd
src/ui/request-mask-memory.ts 4243 a81f870a76006531b2e769203921925263a2e09241ec3fc7bbbd4e24702720fd
src/ui/request-navigation-memory.ts 10321 c3d51c297dc391edfd41d683dab4bb5b82352d253e49af5d3d8c85a84311dbaa
src/ui/request-prompt-memory.ts 9994 32aac1783ba960cd5085af75280d9af8a86035d597b45719e98b8447c7650d1b
src/ui/request-v45-edit.ts 25042 e9d0ea843bfdd5ffcdbe9e822bf9fee6fdfdaf955e34acbe3d4cce1cdf9c0e75
src/ui/request-v45-memory.ts 3821 b4a8851853e00ce39c1c2f8770d92c916150299e4c8e5577dd3eed2288e2948c
src/ui/request-v45.ts 6428 242a196022be95eb18486fd22411aeee42f6ac494dbbccb6d449f69a14cac5d5
src/ui/request.ts 145982 45183e1e7df15490abf15189f70c0d03013d64bc36f292835ba5e2ea6c3b6bf2
src/ui/returned-description.ts 11135 661db3b3aa1ca2f21eeb8a857d66f3fbc99ba3b356503735cc22d28f35c62fc6
src/ui/shell-wordmark.ts 346 0dfcfe84e68da30bf6a0d66bb4159ef197ae718638989f7716009c66ad1b8aad
src/ui/shell.ts 143087 de6efa4b80d625812f883cce94da3d42c5f80fd227fc88fb94cfe3b9baba9c72
src/ui/storage-library.ts 26895 d545b60a0d2cc13707b9d42bd58480693bbf61b533a2269fad0e4ba964878216
src/ui/text-library.ts 8785 e8906796f9508e7de560754ed9e44a17cd11009ca13c1b7e3850d053248dcf50
src/ui/text-treatment.ts 35667 d43659f80639eadf89a4acebc4285d15cc095f8b5011b4fb5fdc03e88f86b7d3
`.trim().split('\n').map(line => {
  const [path, rawBytes, digest] = line.split(' ');
  return Object.freeze({ path, rawBytes: Number(rawBytes), sha256: 'sha256:' + digest });
});

export const D11_APPLICATION_SOURCE_PATHS = Object.freeze(reviewedRows.map(row => row.path));
const bootstrap = Object.freeze({ path: 'inline:bootstrap', rawBytes: 1763, sha256: 'sha256:d4eaf3d55adbaccfbf15cf03c012ecab91389fd2ff866cdc49113c2c7138e2a7' });
const fail = message => { throw Error('D11 application profile: ' + message); };
const scoped = path => path === 'index.html' || path.startsWith('src/');
const identity = (path, text) => ({ path, rawBytes: Buffer.byteLength(text), sha256: 'sha256:' + createHash('sha256').update(text).digest('hex') });

// These are the complete six member-destructuring effects in the reviewed
// corpus. They are source excerpts, not a general permutation exemption. Their
// data producers and native numeric index origins were reviewed together with
// the full corpus; changed surrounding code must fail that review before this
// table is consulted. Offsets use JavaScript string indices, matching the AST.
const memberAssignmentExpressions = [
  // Shared move callback: the two exact render calls pass only -1 and +1.
  ['src/ui/adapter-library.ts', '[next[index+offset],next[index]]=[next[index]!,next[index+offset]!]'],
  ['src/ui/composition.ts', '[es[i],es[j]]=[es[j],es[i]]'],
  ['src/ui/composition.ts', '[a[i-1],a[i]]=[a[i],a[i-1]]'],
  ['src/ui/request-v45-edit.ts', '[next.references[index],next.references[target]]=[next.references[target],next.references[index]]'],
  ['src/ui/shell.ts', '[ids[i],ids[i+1]]=[ids[i+1],ids[i]]'],
  ['src/ui/shell.ts', '[ids[i],ids[i-1]]=[ids[i-1],ids[i]]'],
];

// Internal only: the public verifier calls this after every corpus, finalized
// receipt, and bootstrap identity check. No caller-supplied effects are read.
function reviewedMemberAssignmentEffects(verifiedSources) {
  const sites = memberAssignmentExpressions.map(([source, expression]) => {
    const text = verifiedSources.get(source), start = text.indexOf(expression);
    if (start < 0 || text.indexOf(expression, start + 1) !== -1) fail('reviewed member assignment is absent or ambiguous: ' + source);
    return { source, start, end: start + expression.length,
      sourceSha256: identity(source, text).sha256,
      assignmentSha256: identity(source, expression).sha256,
      effect: 'data-only-array-reordering' };
  });
  sites.sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
  return { kind: 'reviewed-d11-data-member-assignments-1', sites };
}

// The exact corpus binds the sole #layer-tree query to the registered en-tree
// template and these two comparison-only reads. The installed getter/model and
// host consumers require their separate invocation-archive effect; this table
// alone never declares a selectedKeys-named property or a type assertion safe.
function reviewedDOMDataEffects(verifiedSources) {
  const source = 'src/ui/shell.ts', text = verifiedSources.get(source);
  const expression = '(tree as EnTree).selectedKeys[0]', starts = [];
  for (let start = text.indexOf(expression); start !== -1; start = text.indexOf(expression, start + expression.length)) starts.push(start);
  if (starts.length !== 2) fail('reviewed tree data-read inventory differs');
  return { kind: 'reviewed-d11-dom-data-reads-1', sites: starts.map(start => ({
    source, start, end: start + expression.length, sourceSha256: identity(source, text).sha256,
    expressionSha256: identity(source, expression).sha256, effect: 'en-tree-selected-keys-zero-read',
  })) };
}

// The reviewed family module copies eight literal strings from request/core
// and appends three literal strings. Its copied array has no mutation or
// escaping consumer in this exact corpus. Native labels.indexOf supplies an
// array position or -1; the immediate falsy guard returns before undefined can
// reach these four literal-suffix calls on the selected string. This is one
// reviewed source effect, not permission for arbitrary numeric reads, functions
// named endsWith, or type-asserted strings. The event proof still has to match
// the computed read, declaration, and every same-binding invocation below.
function reviewedEventDataEffects(verifiedSources) {
  const source = 'src/ui/request.ts', text = verifiedSources.get(source);
  const expression = 'operations[labels.indexOf(label)]', declarationExpression = 'op=' + expression;
  const callExpression = "op.endsWith('-v45')";
  const unique = expression => {
    const start = text.indexOf(expression);
    if (start < 0 || text.indexOf(expression, start + 1) !== -1) fail('reviewed event data expression is absent or ambiguous');
    return { start, end: start + expression.length, expressionSha256: identity(source, expression).sha256 };
  };
  const read = unique(expression), declaration = unique(declarationExpression), calls = [];
  for (let start = text.indexOf(callExpression); start !== -1; start = text.indexOf(callExpression, start + callExpression.length)) {
    calls.push({ start, end: start + callExpression.length, expressionSha256: identity(source, callExpression).sha256, method: 'endsWith', argument: '-v45' });
  }
  if (calls.length !== 4 || declaration.start + 3 !== read.start || declaration.end !== read.end) fail('reviewed event data invocation inventory differs');
  return { kind: 'reviewed-d11-event-data-calls-1', sites: [{ source, ...read,
    sourceSha256: identity(source, text).sha256, declaration, calls,
    effect: 'request-operation-literal-string-method',
  }] };
}

// Exact receiver review for the current sealed corpus. Authoring and NativeText
// select helpers construct templates; EditorClient.select changes layer selection;
// NativeText.control is its directly created native textarea. ImageImport.select
// belongs to the concrete review controller, including the private shell loader's
// returned controller. None is the public EnFileUpload.select event handler.
// Full corpus verification precedes this finite table; a name/type annotation or
// caller-provided source hash alone cannot grant the nonactivation effect.
const fileSelectionCalls = [
  ["src/ui/authoring.ts", "this.select", "this.select('Selection shape','shape',['rectangle','ellipse','polygon'],v=>{this.shape=v as typeof this.shape;})"],
  ["src/ui/authoring.ts", "this.select", "this.select('Selection combination','combine',['replace','add','subtract','intersect'],v=>{this.combine=v as Combine;})"],
  ["src/ui/authoring.ts", "this.select", "this.select('Brush action','brush',['add','subtract'],v=>this.brush=v as typeof this.brush)"],
  ["src/ui/authoring.ts", "this.select", "this.select('Mask preview view','previewMode',Object.keys(p.views),v=>{this.previewMode=v;})"],
  ["src/ui/authoring.ts", "this.select", "this.select('Sample source','sampleScope',['merged','active'],v=>{this.sampleScope=v;this.sampleGeneration++;})"],
  ["src/ui/image-import.ts", "this.select", "this.select(files)"],
  ["src/ui/native-text.ts", "this.editor.select", "this.editor.select([review.parts[0].layerId])"],
  ["src/ui/native-text.ts", "this.editor.select", "this.editor.select([s.layerId])"],
  ["src/ui/native-text.ts", "this.control.select", "this.control.select()"],
  ["src/ui/native-text.ts", "this.select", "this.select('Text alignment',s.style.align,['left','center','right','start','end'],(s,v)=>s.style={...s.style,align:v as TextStyle['align']})"],
  ["src/ui/native-text.ts", "this.select", "this.select('Text direction',s.style.direction,['auto','ltr','rtl'],(s,v)=>s.style={...s.style,direction:v as TextStyle['direction']})"],
  ["src/ui/shell.ts", "editor.select", "editor.select([id])"],
  ["src/ui/shell.ts", "controls.select", "controls.select(files)"],
  ["src/ui/shell.ts", "editor.select", "editor.select(ids)"],
];
function reviewedFileSelectionEffects(verifiedSources) {
  const sites = fileSelectionCalls.map(([source, expression, callExpression]) => {
    const text = verifiedSources.get(source), start = text.indexOf(callExpression);
    if (start < 0 || text.indexOf(callExpression, start + 1) !== -1 || !callExpression.startsWith(expression + '(')) fail('reviewed file-selection call is absent or ambiguous');
    return { source, start, end: start + expression.length,
      sourceSha256: identity(source, text).sha256, expressionSha256: identity(source, expression).sha256,
      call: { start, end: start + callExpression.length, expressionSha256: identity(source, callExpression).sha256 }, effect: 'non-file-upload-selection' };
  });
  sites.sort((left, right) => left.source.localeCompare(right.source) || left.start - right.start);
  return { kind: 'reviewed-d11-file-selection-calls-1', sites };
}

/** Verify one finite current-source review. Caller-computed hashes or a receipt
 * are necessary join evidence, never authority for an alternative corpus.
 * The bootstrap body comes from the independently derived emitted prelude;
 * source/build/compiler/archive verification remains required by the caller. */
export function verifyD11ApplicationProfile({ sourceTextByPath, sourceInputs, bootstrapText } = {}) {
  if (!sourceTextByPath || typeof sourceTextByPath !== 'object' || Array.isArray(sourceTextByPath) || !Array.isArray(sourceInputs) || sourceInputs.length > 20_000) fail('retained source corpus and finalized inputs are required');
  const names = Object.keys(sourceTextByPath).filter(scoped).sort();
  if (!isDeepStrictEqual(names, D11_APPLICATION_SOURCE_PATHS)) fail('application source inventory differs');
  const receipts = new Map();
  for (const input of sourceInputs) {
    if (!input || typeof input.path !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\\\x00-\x20]+$/.test(input.path) || receipts.has(input.path) || !Number.isSafeInteger(input.rawBytes) || input.rawBytes < 0 || !/^sha256:[a-f0-9]{64}$/.test(input.sha256 ?? '')) fail('finalized source input is malformed or duplicated');
    receipts.set(input.path, { path: input.path, rawBytes: input.rawBytes, sha256: input.sha256 });
  }
  if (!isDeepStrictEqual([...receipts.keys()].filter(scoped).sort(), D11_APPLICATION_SOURCE_PATHS)) fail('finalized application source inventory differs');
  const verifiedSources = new Map();
  let total = 0;
  for (const expected of reviewedRows) {
    const text = sourceTextByPath[expected.path];
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1048576 || (total += Buffer.byteLength(text)) > 256 * 1048576) fail('reviewed application source is missing or oversized: ' + expected.path);
    const actual = identity(expected.path, text);
    if (!isDeepStrictEqual(actual, expected)) fail('reviewed application source differs: ' + expected.path);
    if (!isDeepStrictEqual(receipts.get(expected.path), expected)) fail('finalized application source differs: ' + expected.path);
    verifiedSources.set(expected.path, text);
  }
  if (typeof bootstrapText !== 'string' || Buffer.byteLength(bootstrapText) !== bootstrap.rawBytes || !isDeepStrictEqual(identity(bootstrap.path, bootstrapText), bootstrap)) fail('reviewed inline bootstrap differs');
  return { kind: 'verified-d11-application-profile-1', profile: 'reviewed-d11-startup-corpus-1', inputs: [...reviewedRows.map(row => ({ ...row })), { ...bootstrap }], memberAssignmentEffects: reviewedMemberAssignmentEffects(verifiedSources), domDataEffects: reviewedDOMDataEffects(verifiedSources), eventDataEffects: reviewedEventDataEffects(verifiedSources), fileSelectionEffects: reviewedFileSelectionEffects(verifiedSources) };
}

export const verifyD11ApplicationSourceProfile = verifyD11ApplicationProfile;
