import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {verifyNavigationWindowServerEvidence} from '../../../tooling/qualification/campaigns/windowserver-navigation-verification.mjs';
import {normalizeResult} from '../../../tooling/qualification/campaigns/worker.mjs';
import {sanitize} from '../../../tooling/qualification/campaigns/common.mjs';
import {verifyNavigationStatus} from '../../../tooling/qualification/campaigns/navigation-status.mjs';

// Synthetic retained protocol bytes only. No browser, compiler, collector,
// display or native process is started. Tiny whole-viewport pixels and a
// nonexecutable Mach-O header exercise admission, never physical qualification.
// Importing this support module performs no file I/O and registers no tests.
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ndjson = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
const pin = (path, bytes) => ({path, bytes: bytes.length, sha256: sha(bytes)});
const file = (bytes, mode) => ({bytes: bytes.length, sha256: sha(bytes), mode});
export const navigationSpecimenUUID = '11111111-1111-4111-8111-111111111111';

// Match synchronous product publications and their separately retained phase
// trace. The reopen phase ends after the first opened publication, before idle.
export function navigationSemanticSpecimen({navigationNonce,documentId,acceptedEdit,autoOpen=false,falsePendingOrCompletionCount=0}) {
  assert.ok([0,1,2].includes(falsePendingOrCompletionCount));
  const rows=[];
  let current={sourceId:'01234567-89ab-4cde-8fab-0123456789ab',lifecycle:0,documentGeneration:0,sessionId:'editor_null',documentId:null,revision:null,cursor:'0'};
  const row=(kind,patch={},rest={})=>{current={...current,...patch};rows.push({kind,sequence:rows.length+1,atMs:(rows.length+1)*10,...current,...rest});};
  const state=(status,busy=false,patch={})=>row('state',patch,{status,ready:!['connect','recovering'].includes(status),busy,hasError:false,hasRecovery:false});
  state('connect');state('recovering',false,{lifecycle:1,sessionId:'editor_owner'});
  state('recovering',false,{sessionId:'ui_fixture'});
  if(autoOpen)state('recovering',false,{documentGeneration:1,documentId,revision:'1',cursor:'3'});
  row('recovered');state('recovered');
  state('opening',true);state('opening',true,{documentGeneration:autoOpen?2:1,documentId,revision:'1',cursor:'3'});
  row('opened');state('opened',true);state('opened');state('saving',true);
  row('checkpoint',{cursor:'5'},{commandId:acceptedEdit.commandId,transactionId:acceptedEdit.transactionId,fromSeq:'4',toSeq:'5'});
  state('saved',true);state('saved');
  const first=status=>rows.find(row=>row.status===status),authority=kind=>rows.find(row=>row.kind===kind);
  if(falsePendingOrCompletionCount>=1)first('opening').busy=false;
  if(falsePendingOrCompletionCount>=2)first('saving').busy=false;
  const phase=(sequence,name,start,end,outcome,context)=>({sequence,phase:name,startedMs:start,endedMs:end,durationMs:end-start,outcome,context});
  const status={kind:'navigation-status-1',timeOriginMs:200000,capacity:128,dropped:0,invalid:0,closed:false,rows};
  const phaseSnapshot={navigationStatus:status,trace:{schemaVersion:1,lane:'browser-main',clockOriginUnixMs:200000.25,clockUncertaintyMs:null,dropped:0,invalid:0,records:[
    phase(1,'reopen',first('opening').atMs+1,first('opened').atMs+1,'incomplete',{documentId,revision:'1',boundary:'observed'}),
    phase(2,'command.accept',first('saving').atMs+1,authority('checkpoint').atMs-1,'ok',{commandId:acceptedEdit.commandId,transactionId:acceptedEdit.transactionId,documentId,revision:'1',replay:false,boundary:'authority-durable'}),
  ]}};
  const witness={kind:'navigation-semantic-witness-1',navigationNonce,status};
  return {witness,rows,status,phaseSnapshot,acceptedEdit,first,authority};
}

function syntheticBuild(sourceBytes, historicalRoot) {
  const scope = 'pinned source/compiler executable/SDK observed build';
  const directory = join(historicalRoot, 'build'), compilerPath = join(historicalRoot, 'compiler'), sdkPath = join(historicalRoot, 'sdk');
  const moduleCache = join(directory, 'module-cache');
  const sdk = {kind: 'windowserver-sdk-tree-1', entries: [{path: '.', type: 'directory', mode: 0o700}]};
  const sdkBytes = json(sdk), sdkTreeDigest = sha(JSON.stringify(sdk));
  const compiler = file(Buffer.from('synthetic compiler metadata; never executed\n'), 0o700), source = file(sourceBytes, 0o600);
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
  // Exact insertion order matches the build protocol's recorded environment.
  const environment = {PATH: dirname(compilerPath) + ':/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    LANG: 'C', LC_ALL: 'C', SDKROOT: sdkPath, SWIFT_MODULECACHE_PATH: moduleCache, CLANG_MODULE_CACHE_PATH: moduleCache};
  const command = (stage, args) => ({stage, executable: compilerPath, args, cwd: directory, environment,
    result: {code: 0, signal: null, timedOut: false, interrupted: false, error: null, timeoutMs: 1000},
    logs: {stdout: pin(stage + '.stdout.log', Buffer.alloc(0)), stderr: pin(stage + '.stderr.log', Buffer.alloc(0))}});
  const receipt = {kind: 'windowserver-collector-build-1', schemaVersion: 1, scope, qualification: false, status: 'PASS',
    startedAt: '2026-09-30T00:00:00.000Z', endedAt: '2026-09-30T00:00:00.000Z', host: {platform: 'synthetic-test', arch: 'arm64', release: 'fixture'}, timeoutMs: 1000,
    pins: {sourceSha256: sha(sourceBytes), compilerSha256: compiler.sha256, sdkTreeDigest},
    source: {path: join(historicalRoot, 'capture.swift'), retainedPath: 'collector.swift', before: source, after: source, retained: source},
    compiler: {path: compilerPath, before: compiler, after: compiler},
    sdk: {path: sdkPath, manifestPath: 'sdk-manifest.json', manifest: {bytes: sdkBytes.length, sha256: sha(sdkBytes)}, beforeDigest: sdkTreeDigest, afterDigest: sdkTreeDigest, entryCount: 1},
    commands: [command('version', ['--driver-mode=swiftc', '--version']), command('build', ['--driver-mode=swiftc', '-O', '-target', 'arm64-apple-macosx15.0',
      '-sdk', sdkPath, '-module-cache-path', moduleCache, '-o', join(directory, 'windowserver-capture'), join(directory, 'collector.swift')])],
    binaryBefore: null, binary: file(binary, 0o700), error: null};
  const receiptBytes = json(receipt);
  const members = [['build-receipt.json', receiptBytes, 0o600], ['collector.swift', sourceBytes, 0o600], ['sdk-manifest.json', sdkBytes, 0o600],
    ...['version.stdout.log', 'version.stderr.log', 'build.stdout.log', 'build.stderr.log'].map(name => [name, Buffer.alloc(0), 0o600]),
    ['windowserver-capture', binary, 0o700]];
  const manifest = {kind: 'windowserver-build-evidence-1', schemaVersion: 1, scope, qualification: false,
    sourceSha256: sha(sourceBytes), receiptSha256: sha(receiptBytes), binarySha256: sha(binary), compilerSha256: compiler.sha256, sdkTreeDigest,
    members: members.map(([path, bytes, mode]) => ({path, ...file(bytes, mode)}))};
  const manifestBytes = json(manifest);
  return {members: [...members, ['manifest.json', manifestBytes, 0o600]], manifestBytes, receiptSha256: sha(receiptBytes), binaryBytes: binary.length, binarySha256: sha(binary),
    receiptPath: join(directory, 'build-receipt.json'), binaryPath: join(directory, 'windowserver-capture')};
}


export async function windowServerNavigationSpecimen(t, options = {}) {
  const {workload = 'W0', cache = 'cold', ordinal = 1, serial = ordinal, prime = false,
    shellUpperBoundMs = 50, canvasUpperBoundMs = 250, mutateCapture, mutateProcess,
    mutateOracle, mutateBrowser, mutateProducer, mutateNative, mutateSemantic} = options;
  const root = await mkdtemp(join(await realpath(tmpdir()), 'navigation-retained-protocol-'));
  await chmod(root, 0o700); t.after(() => rm(root, {recursive:true, force:true}));
  const groupOutput = join(root, 'absent-original-group'), historicalRoot = join(root, 'absent-build-inputs');
  const archive = join(root, 'relocated-evidence'); await mkdir(archive, {mode:0o700});
  const members = new Map(), modes = new Map();
  const put = (path, bytes, mode = 0o600) => {members.set(path, bytes); modes.set(path, mode); return pin(path, bytes);};
  const nonce = 'a'.repeat(48), nativeId = 'nv-' + nonce, uuid = navigationSpecimenUUID;
  const folders = Object.fromEntries(['anchor','shell','canvas'].map(stage => [stage, 'native-nav-' + nonce + '-' + stage]));
  const oracleFolders = Object.fromEntries(['shell','canvas'].map(stage => [stage, 'oracle-nav-' + nonce + '-' + stage]));
  const collectorBytes = Buffer.from('// synthetic retained collector; never compiled\n');
  const build = syntheticBuild(collectorBytes, historicalRoot);
  const selectedFixture = {documentId:'document-fixture', seal:{path:'/absent/fixture/manifest.json', sha256:'f'.repeat(64)}};
  const sourceRoot = '/absent/prepared/source', browserCache = '/absent/browser-cache';
  const environment = {sourceDigest:'sha256:' + 'c'.repeat(64), buildDigest:'sha256:' + 'b'.repeat(64),
    toolsDigest:'sha256:' + 'd'.repeat(64), controlDigest:'sha256:' + 'e'.repeat(64), host:{platform:'synthetic-test'}};
  const workerProcessIdentity = {pid:100, node:'v26.10.0', startedAt:'2026-09-30T00:00:00.000Z'};
  const runtime = {headless:false, browserPid:23, backendPid:24, engine:'chromium', version:'fixture-version', revision:'fixture-revision',
    executable:join(browserCache, 'chromium/browser'), executableIdentity:{bytes:1, sha256:'sha256:' + 'e'.repeat(64)},
    playwrightModule:join(sourceRoot, 'node_modules/playwright/index.js'), root:join(groupOutput, 'root'), fixtureSeal:selectedFixture.seal,
    viewport:{width:2,height:1}, deviceScaleFactor:1, proxyRoute:{status:'PASS'}, capabilitySetup:{status:'PASS'},
    ownedLaunch:{context:{createdBy:'browser.newContext'}, process:{startedAtIdentity:'synthetic-browser-birth',
      registration:{path:join(groupOutput, 'owned-process-23-' + uuid + '.json')}}}};
  const browserIdentity = {cache:{sha256:'sha256:' + 'd'.repeat(64)}, engines:[{engine:runtime.engine, executable:runtime.executable,
    version:runtime.version, revision:runtime.revision, ...runtime.executableIdentity}]};
  const state = {productRepo:sourceRoot, sourceDigest:environment.sourceDigest,
    h:{source:sourceRoot, workspace:dirname(sourceRoot), completed:true, browserCache, browserIdentity}};
  const developerState = {kind:'developer-runtime-state-1', state, sha256:sha(json(state))};
  const developerStateIdentity = pin('/absent/prepared/bridge-state.json', json(developerState));
  const tools = {node:{executable:'/absent/node',version:'26.10.0'},
    browserPins:{browsers:[{name:runtime.engine,browserVersion:runtime.version,revision:runtime.revision}]}};
  mutateBrowser?.({runtime,state,developerState,developerStateIdentity,tools});
  put('browser-runtime.json', json(runtime));
  for (const [kind,pid,executable] of [['browser',runtime.browserPid,runtime.executable],['backend',runtime.backendPid,tools.node.executable]]) {
    put('owned-process-' + pid + '-' + uuid + '.json', json({kind:'perf-owned-processes-1',ownerPid:workerProcessIdentity.pid,
      processes:[{kind,pid,pgid:pid,startedAtIdentity:'synthetic-' + kind + '-birth',executable}]}));
  }
  const rule = {budgetId:'R05',name:cache === 'cold' ? 'R05UsableCanvasColdMs' : 'R05UsableCanvasWarmMs',unit:'ms',cache,
    ceiling:cache === 'cold' ? 4000 : 2000};
  const semanticRule = {budgetId:'R04',name:'R04FalsePendingOrCompletionCount',unit:'violations',ceiling:0};
  const cell = {id:'H1/chromium-' + workload + '-ready', jobId:'H1', host:'H', kind:'navigation', handler:'browser',
    operation:'navigation.ready', workload, parameters:{browser:'chromium'}, requiredMeasurements:options.requiredMeasurements ?? [rule,semanticRule],
    ...options.cell};
  const sample = {cache,ordinal,prime}, attemptId = cell.id + '/' + cache + '/' + (prime ? 'prime' : 'scored') + '/' + ordinal;
  const attemptBinding = {cellId:cell.id,workload,cache,ordinal,prime,serial,attemptId,documentId:selectedFixture.documentId,fixtureSeal:selectedFixture.seal};
  const invocation = {kind:'windowserver-navigation-invocation-1',cellId:cell.id,workload,cache,ordinal,prime,serial,attemptId,
    sourceRoot,workerProcessIdentity,environment};
  const browserEnvironment = {engine:runtime.engine,version:runtime.version,revision:runtime.revision,
    executableSha256:runtime.executableIdentity.sha256.replace(/^sha256:/,''),viewport:runtime.viewport,deviceScaleFactor:runtime.deviceScaleFactor};
  const rendering = {fixtureSha256:selectedFixture.seal.sha256,browserEnvironmentSha256:sha(JSON.stringify(browserEnvironment)),
    environment:browserEnvironment,sourceDigest:environment.sourceDigest.replace(/^sha256:/,''),buildDigest:environment.buildDigest.replace(/^sha256:/,'')};
  const roi = {x:4,y:3,width:2,height:1}, display = {id:7,width:100,height:60};
  const beforePixels = Buffer.from([0,1,2,255,3,4,5,255]);
  const afterPixels = {shell:Buffer.from([6,7,8,255,9,10,11,255]),canvas:Buffer.from([12,13,14,255,15,16,17,255])};
  const canonical = {documentId:selectedFixture.documentId,width:2,height:1,layerCount:1,assetId:'fixture-composite',assetHash:'sha256:' + '8'.repeat(64)};
  const oracles = {}, oraclePins = {};
  for (const endpoint of ['shell','canvas']) {
    const oracle = {kind:'navigation-pixel-oracle-1',schemaVersion:1,endpoint,
      subject:endpoint === 'shell' ? 'whole-application-shell' : 'canonical-document-viewport',
      binding:{fixtureSha256:rendering.fixtureSha256,browserEnvironmentSha256:rendering.browserEnvironmentSha256,
        sourceDigest:rendering.sourceDigest,buildDigest:rendering.buildDigest,workload,cache,documentId:selectedFixture.documentId},
      display,roi,pixelFormat:'BGRA8',
      coverage:{kind:endpoint === 'shell' ? 'whole-browser-viewport' : 'whole-canonical-canvas',
        viewport:{...runtime.viewport,deviceScaleFactor:runtime.deviceScaleFactor},cssRectangle:{x:0,y:0,width:2,height:1}},
      canonical:endpoint === 'shell' ? null : canonical,
      before:{state:'pre-navigation-blank',...pin('before.bgra',beforePixels)},
      after:{state:endpoint === 'shell' ? 'native-shell-ready' : 'canonical-canvas-ready',...pin('after.bgra',afterPixels[endpoint])}};
    mutateOracle?.({endpoint,oracle});
    const bytes = json(oracle); put(oracleFolders[endpoint] + '/oracle.json',bytes);
    put(oracleFolders[endpoint] + '/before.bgra',beforePixels); put(oracleFolders[endpoint] + '/after.bgra',afterPixels[endpoint]);
    oracles[endpoint] = oracle;
    oraclePins[endpoint] = {...pin(join(groupOutput,oracleFolders[endpoint],'oracle.json'),bytes),
      pixels:[pin('before.bgra',beforePixels),pin('after.bgra',afterPixels[endpoint])]};
  }
  const buildSelection = {receiptPath:build.receiptPath,receiptSha256:build.receiptSha256};
  const limits = {durationMs:10000,maxFrames:2,maxBytes:32};
  const selection = {kind:'windowserver-navigation-configuration-1',build:buildSelection,displayID:7,
    profiles:[{workload,cache,roi,shell:{path:join(historicalRoot,'shell-oracle.json'),sha256:oraclePins.shell.sha256},
      canvas:{path:join(historicalRoot,'canvas-oracle.json'),sha256:oraclePins.canvas.sha256}}],
    capture:{anchor:{...limits},shell:{...limits},canvas:{...limits}},maxTotalBytes:96};
  const configuration = {browser:{engine:'chromium',windowServerNavigation:selection}};
  const binding = {kind:'navigation-windowserver-input-binding-1',navigationNonce:nonce,attempt:attemptBinding,invocation,browser:runtime,
    environment:rendering,selection,capturePlan:{stages:3,maxFrames:6,maxPixelBytes:96,reservedPixelBytes:96},
    collectorSource:pin(join(historicalRoot,'capture.swift'),collectorBytes),oracles:oraclePins};
  const navigation = {nonce,previousTimeOrigin:100000,timeOrigin:200000,entry:{startTime:0,type:'navigate',name:'http://127.0.0.1:4321/'},visibility:'visible',topLevel:true};
  const controls = names => names.map(name => ({name,visible:true,enabled:true}));
  const witnesses = {
    shell:{navigation,readyMs:120,recoveryText:'Local recovery complete. Accepted edits are saved locally.',
      controls:controls(['New','Open']),viewport:{...runtime.viewport,deviceScaleFactor:runtime.deviceScaleFactor}},
    canvas:{navigation,readyMs:200,canonical:{...canonical,revision:'1'},viewport:{asset:canonical.assetId,visible:true,x:0,y:0,width:2,height:1},
      toolbar:controls(['New','Open','Import image','Close document','Export image']),acceptedEdit:{commandId:'fixture-edit',documentId:selectedFixture.documentId,
        status:'accepted',documentRevision:'1',transactionId:'fixture-transaction'},stableRevision:true},
  };
  const semantic = navigationSemanticSpecimen({navigationNonce:nonce,documentId:selectedFixture.documentId,acceptedEdit:witnesses.canvas.acceptedEdit,
    autoOpen:options.autoOpen,falsePendingOrCompletionCount:options.falsePendingOrCompletionCount});
  mutateSemantic?.(semantic);
  const nativeBefore = 10000000;
  const clock = (id,mach) => ({schemaVersion:1,event:'clock',id,mach:String(mach)});
  const anchor = {kind:'navigation-native-bracket-1',status:'complete',dispatchCompleted:true,startedRunnerMs:100,completedRunnerMs:110,
    before:clock(nativeId + '-before',nativeBefore),after:null};
  const readiness = Object.fromEntries(['shell','canvas'].map(endpoint => [endpoint,{kind:'navigation-native-readiness-1',endpoint,status:'complete',
    requestRunnerMs:endpoint === 'shell' ? 121 : 201,receivedRunnerMs:endpoint === 'shell' ? 122 : 202,witness:witnesses[endpoint],
    ack:clock(nativeId + (endpoint === 'shell' ? '-s-ready' : '-c-ready'),nativeBefore + Math.round((endpoint === 'shell' ? shellUpperBoundMs : canvasUpperBoundMs) * 1000000))}]));
  const captures = {}, rawCaptures = {}, processRecords = {};
  for (const [index,stage] of ['anchor','shell','canvas'].entries()) {
    const folder = folders[stage], captureFolder = folder + '/capture';
    for (const [name,bytes,mode] of build.members) put(folder + '/build-evidence/' + name,bytes,mode);
    const config = {schemaVersion:1,displayID:7,expectedBrowserPid:runtime.browserPid,roi,...limits};
    const geometry = {displayBoundsPoints:{x:0,y:0,width:100,height:60},displayPoints:{x:0,y:0,width:100,height:60},
      modePixels:{width:100,height:60},filterPoints:{x:0,y:0,width:100,height:60},pointPixelScale:1,backingScale:{x:1,y:1},
      scalesToFit:false,showsCursor:true,capturesAudio:false,queueDepth:3,pixelFormat:'BGRA'};
    const admission = {ownerPID:runtime.browserPid,windowNumber:9,bounds:{x:0,y:0,width:100,height:60},layer:0,alpha:1,onScreen:true,
      roiPoints:{...roi},aboveVisibleWindowCount:2,intersectingAboveWindowCount:0};
    const pixels = stage === 'anchor' ? beforePixels : afterPixels[stage];
    const ack = stage === 'anchor' ? anchor.before : readiness[stage].ack;
    const displayMach = stage === 'anchor' ? 5000000 : Number(ack.mach) - 1000000;
    const startedMach = stage === 'anchor' ? '0' : stage === 'shell' ? '11000000' : String(Number(readiness.shell.ack.mach) + 2000000);
    const endedMach = stage === 'anchor' ? anchor.before.mach : String(Number(ack.mach) + 1000000);
    const timing = {startedMach,endedMach}, timebase = {numer:1,denom:1};
    const rows = [{schemaVersion:1,event:'sample',ordinal:1,statusRaw:0,status:'complete',ownerPID:runtime.browserPid,windowNumber:9,
      callbackMach:String(displayMach + 500000),windowObservationMach:String(displayMach + 500001),displayTimeMach:String(displayMach),
      aboveVisibleWindowCount:2,intersectingAboveWindowCount:0,pts:{value:'0',timescale:1,flags:0,epoch:'0'},pixelFormat:1111970369,
      width:100,height:60,roi,retained:true,file:'frame-1.bgra',sha256:sha(pixels),byteLength:pixels.length,contentScale:1,scaleFactor:1},ack];
    mutateCapture?.({stage,config,display,geometry,admission,rows,timing,timebase});
    const framesBytes = ndjson(rows), manifest = {kind:'windowserver-capture-1',schemaVersion:1,config,display,captureGeometry:geometry,windowAdmission:admission,
      timebase,...timing,terminalReason:'requested-stop',
      counts:{sampleRecords:1,completeFrames:1,clockRecords:1,pixelBytes:8,unretainedSamples:0},frames:pin('frames.ndjson',framesBytes),
      pixelFiles:[pin('frame-1.bgra',pixels)]};
    const manifestBytes = json(manifest); put(captureFolder + '/manifest.json',manifestBytes);
    put(captureFolder + '/frames.ndjson',framesBytes); put(captureFolder + '/frame-1.bgra',pixels);
    const ready = {schemaVersion:1,event:'ready',kind:manifest.kind,config,outputDirectory:join(groupOutput,captureFolder),display,
      captureGeometry:geometry,windowAdmission:admission,roi,timebase:manifest.timebase,startedMach:timing.startedMach,pixelByteLimit:config.maxBytes,
      metadataByteLimit:8*1024**2,manifestByteLimit:2*1024**2,maxClockRecords:256,pointPixelScale:1};
    const stopped = {schemaVersion:1,event:'stopped',terminalReason:manifest.terminalReason,endedMach:timing.endedMach,manifest:'manifest.json'};
    const stdout = ndjson([ready,...rows,stopped]); put(folder + '/stdout.ndjson',stdout); put(folder + '/stderr.log',Buffer.alloc(0));
    const configBytes = json(config); put(folder + '/config.json',configBytes);
    const pid = 123 + index, processIdentity = {kind:'windowserver',ownerPid:workerProcessIdentity.pid,pid,pgid:pid,
      startedAtIdentity:'synthetic-' + stage + '-birth',executable:build.binaryPath};
    const registrationPath = 'owned-process-' + pid + '-' + uuid + '.json';
    const registrationBytes = json({kind:'perf-owned-processes-1',ownerPid:workerProcessIdentity.pid,processes:[{kind:'windowserver',pid,pgid:pid,
      startedAtIdentity:processIdentity.startedAtIdentity,executable:build.binaryPath}]});
    put(registrationPath,registrationBytes);
    const processRecord = {kind:'windowserver-owned-process-1',schemaVersion:1,outcome:'CAPTURE_REPLAYED',failure:null,cleanupErrors:[],requestedSignals:[],
      exit:{code:0,signal:null},close:{code:0,signal:null},processIdentity,registration:pin(join(groupOutput,registrationPath),registrationBytes),
      config:pin('config.json',configBytes),build:{...buildSelection,sourceSha256:sha(collectorBytes)},
      buildEvidence:{...pin('build-evidence/manifest.json',build.manifestBytes),sourceSha256:sha(collectorBytes),
        receiptSha256:build.receiptSha256,binarySha256:build.binarySha256},
      executable:{path:build.binaryPath,bytes:build.binaryBytes,sha256:build.binarySha256},
      command:[build.binaryPath,join(groupOutput,folder,'config.json'),join(groupOutput,captureFolder)],outputDirectory:join(groupOutput,captureFolder),
      stdout:pin('stdout.ndjson',stdout),stderr:pin('stderr.log',Buffer.alloc(0)),streamBytesObserved:{stdout:stdout.length,stderr:0},
      manifest:pin('capture/manifest.json',manifestBytes)};
    mutateProcess?.({stage,process:processRecord});
    const processBytes = json(processRecord); put(folder + '/process.json',processBytes);
    captures[stage] = {ready,process:{...processRecord,receipt:pin(join(groupOutput,folder,'process.json'),processBytes)},
      evidence:{manifest:pin(join(groupOutput,captureFolder,'manifest.json'),manifestBytes)}};
    rawCaptures[stage] = {manifestBytes,framesBytes,pixels:new Map([['frame-1.bgra',pixels]])};
    processRecords[stage] = processRecord;
  }
  const joins = Object.fromEntries(['shell','canvas'].map(endpoint => {
    const upperBoundMs = endpoint === 'shell' ? shellUpperBoundMs : canvasUpperBoundMs;
    const ceilingMs = endpoint === 'shell' ? 750 : cache === 'cold' ? 4000 : 2000;
    return [endpoint,{kind:'navigation-windowserver-pixel-join-1',endpoint,subject:oracles[endpoint].subject,source:'ScreenCaptureKit-full-display',qualification:false,
      oracleSha256:oraclePins[endpoint].sha256,anchorCaptureSha256:sha(rawCaptures.anchor.manifestBytes),captureSha256:sha(rawCaptures[endpoint].manifestBytes),
      budget:endpoint === 'shell' ? 'R04' : 'R05',ceilingMs,upperBoundMs,exactLatencyMs:null,physicalScanout:'unavailable',displaySlotCoverage:'unavailable',
      firstPresentedFrameCoverage:'unavailable',browserToNativeClockCorrelation:'unavailable',semanticReviewRequired:true,collectorSourceAndInvocationAdmissionRequired:true,
      status:'observed',baselineOrdinal:1,matchedOrdinal:1,observedDisplayTimeMach:String(Number(readiness[endpoint].ack.mach)-1000000),
      readinessMach:readiness[endpoint].ack.mach,nativeLowerAnchor:anchor.before.mach,nativeUpperEndpoint:readiness[endpoint].ack.mach,
      ceilingAssessment:upperBoundMs <= ceilingMs ? 'upper-bound-within-ceiling' : 'unavailable-earliest-endpoint-not-proven'}];
  }));
  const observation = {kind:'navigation-windowserver-observation-1',qualification:false,navigationNonce:nonce,nativeId,binding,anchor,readiness,captures,joins,
    semanticWitness:semantic.witness,missing:[],failures:[]};
  mutateNative?.(observation);
  const rawName = 'navigation-nav-' + nonce + '.json', rawBytes = json(observation);
  put(rawName,rawBytes);
  const artifact = pin(join(groupOutput,rawName),rawBytes);
  const nativeNavigation = {...observation,artifact};
  const measurement = {name:rule.name,value:null,upperBoundMs:canvasUpperBoundMs,bound:'upper',unit:'ms',
    method:'Owned WindowServer semantic pixels and public-ready ACK, from pre-navigation native anchor; exact latency unavailable',
    evidence:{kind:'navigation-windowserver-bound-1',artifact,navigationNonce:nonce,endpoint:'canvas',exactLatencyMs:null}};
  const semanticResult=verifyNavigationStatus(semantic.witness,{navigationNonce:nonce,documentId:selectedFixture.documentId,
    acceptedEdit:witnesses.canvas.acceptedEdit,phaseSnapshot:semantic.phaseSnapshot});
  const semanticMeasurement={name:semanticRule.name,value:semanticResult.falsePendingOrCompletionCount,unit:'violations',
    method:'Replayed original synchronous navigation status ledger and accepted command authority',
    evidence:{kind:'navigation-semantic-ledger-1',artifact,navigationNonce:nonce,observationId:attemptId,timeOriginMs:semantic.status.timeOriginMs}};
  const measurements=cell.requiredMeasurements.flatMap(value=>value.name===rule.name && canvasUpperBoundMs<=rule.ceiling?[measurement]:
    value.name===semanticRule.name && (!value.cache || value.cache===cache) && semanticResult.complete?[semanticMeasurement]:[]);
  const producer = {cellId:cell.id,operation:cell.operation,status:semanticResult.complete && semanticResult.falsePendingOrCompletionCount>0?'FAIL':'PASS',timingSamplesReusable:true,nativeNavigation,
    phases:[],missing:[],measurements,evidence:{productPhases:semantic.phaseSnapshot},
    observations:{documentId:selectedFixture.documentId,acceptedTestEdit:true,startupBoundary:'document-ready-via-Open',publicOpenCompleted:true,
      nativeReadiness:{shell:readiness.shell.witness,canvas:readiness.canvas.witness},navigation:readiness.shell.witness.navigation,
      navigationSemantic:semantic.witness,productPhases:semantic.phaseSnapshot}};
  mutateProducer?.(producer);
  const producerName = 'browser-cell-' + serial + '.json';
  put(producerName,json(sanitize(producer)));
  const attempt = sanitize({id:attemptId,...sample,startMs:90,endMs:300,status:producer.status,
    result:normalizeResult({...producer,artifacts:[join(groupOutput,producerName)]},90,300)});
  put('input.json',json({cell,navigationEnvironment:environment,fixture:selectedFixture,configuration,repo:sourceRoot,cache,attempts:[{ordinal,prime}]}));
  for (const [path,bytes] of members) {
    const destination = join(archive,path); await mkdir(dirname(destination),{recursive:true,mode:0o700});
    await writeFile(destination,bytes,{flag:'wx',mode:modes.get(path)}); await chmod(destination,modes.get(path));
  }
  const reads = [], resolutions = [], retainedPaths = [...members.keys()];
  function retainedPath(path) {assert.equal(isAbsolute(path),false); const actual = resolve(archive,path); assert.ok(actual.startsWith(archive + '/')); return actual;}
  const context = {attempt,cell,serial,configuration,groupOutput,retainedPaths,
    readRetained:async (path,{maximum}) => {const actual=retainedPath(path); assert.ok(Number.isSafeInteger(maximum) && maximum>0);
      assert.ok((await stat(actual)).size<=maximum); reads.push(path); return readFile(actual);},
    resolveRetained:async path => {resolutions.push(path); return retainedPath(path);},
    controlFiles:[pin('tooling/qualification/native/windowserver-capture.swift',collectorBytes),
      ...['browser.mjs','browser-driver.mjs','browser-measurements.mjs','windowserver-navigation.mjs','windowserver-navigation-contract.mjs',
        'windowserver-navigation-verification.mjs','navigation-status.mjs','worker.mjs','run.mjs','verification.mjs'].map(name => pin('tooling/qualification/campaigns/' + name,Buffer.from('// synthetic control source\n')))],
    sourceFiles:['src/ui/shell.ts','src/state/editor-client.ts','src/observability/navigation-observations.ts','src/observability/browser.ts'].map(path => pin(path,Buffer.from('// synthetic application source\n'))),
    fixture:selectedFixture,workerProcessIdentity,environment,sourceRoot,browserCache,tools,developerState,developerStateIdentity};
  return {root,archive,groupOutput,historicalRoot,folders,oracleFolders,rawName,producerName,nonce,context,args:context,attempt,cell,sample,
    observation,producer,semantic,processRecords,rawCaptures,oracles,reads,resolutions,members,path:retainedPath,
    replay:() => verifyNavigationWindowServerEvidence(context),
    write:async (path,bytes) => {members.set(path,bytes); await writeFile(retainedPath(path),bytes);},
    rewrite:async (path,change) => {const value=JSON.parse(await readFile(retainedPath(path),'utf8')); change(value); await writeFile(retainedPath(path),json(value));},
    forget:path => {const index=retainedPaths.indexOf(path); assert.notEqual(index,-1); retainedPaths.splice(index,1);}};
}
