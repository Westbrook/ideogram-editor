import {createHash} from 'node:crypto';
import {canonical} from '../../dist/local/src/protocol/json.js';
export const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export const ref=(mediaType='application/json',byteLength='2')=>({hash:digest(mediaType+byteLength),byteLength,mediaType});
export function fixture(metadata=false){
 const document={id:'projection_document',revision:'1',branchId:'branch',width:3,height:2,color:'sRGB',depth:8,orderedLayerIds:[],historyHead:'history',checkpoint:null,compositionVersion:null,...metadata?{metadata:{schemaVersion:1,name:'Café 東京',creationBackground:{kind:'transparent'}}}:{}};
 const history={id:'history',documentId:document.id,branchId:'branch',parent:null,forward:{before:null,after:document},inverse:{before:document,after:null},roots:[]};
 const base={schemaVersion:1,payloadVersion:1,streamId:document.id,documentId:document.id,commandId:'command',correlationId:'correlation',causationId:null,transactionId:'transaction',writerEpoch:'1',recordedAt:'2026-09-30T00:00:00.000Z'};
 const created={...base,eventId:'event_1',workspaceSeq:'1',streamSeq:'1',resultingDocumentRevision:'1',type:'DocumentCreated',payload:{document,history}};
 const checkpoint={...base,eventId:'event_2',workspaceSeq:'2',streamSeq:'2',resultingDocumentRevision:'2',type:'CheckpointSaved',payload:{checkpoint:{id:'checkpoint',name:'保存 🧭',documentId:document.id,documentRevision:'1',historyHead:'history',highWater:'2'}}};
 return {document,history,created,checkpoint};
}
export const context=(projectionSchema=9,highWater='2')=>({recoveryId:'recovery',writerEpoch:'1',projectionSchema,highWater,expiresAt:'2099-01-01T00:00:00.000Z'});
export function snapshot(schema=9,metadata=true){
 const f=fixture(metadata),rows=[{kind:'header',snapshotId:'snapshot',snapshotSeq:'1',projectionSchema:schema,entityCount:'2'},...['document','history'].map(type=>({kind:'projection-part',entityType:type,entityId:f[type].id,entityVersion:'1',partIndex:0,partCount:1,utf8Base64:Buffer.from(canonical(f[type])).toString('base64')}))];
 const bytes=Buffer.from(rows.map(canonical).join('\n')+'\n'),recovery=context(),content={contentId:'content',url:'/api/v1/protocol-content/content?recoveryId=recovery',blob:{hash:digest(bytes),byteLength:String(bytes.length),mediaType:'application/x-ndjson'},encoding:'lp1-snapshot-jsonl',recordCount:String(rows.length),expiresAt:recovery.expiresAt};content.url='/api/v1/protocol-content/content?recoveryId='+recovery.recoveryId;
 return {...f,rows,bytes,descriptor:{protocolVersion:1,snapshotId:'snapshot',metadataUrl:'/api/v1/snapshots/snapshot?recoveryId=recovery',snapshotSeq:'1',recovery,content}};
}
export function previewEvent(textTreatment=false){
 const {created}=fixture(),image={state:ref(),semanticDigest:digest('semantic'),compositeAssetId:null},candidate={candidateId:'candidate',mode:'full-candidate',placement:'current-document',newDocumentId:null,coverage:null,outputMapping:null};
 if(textTreatment)candidate.textTreatment={kind:'candidate-text-treatment-preview-1',plan:{kind:'request-text-treatment-1',plan:ref(),planHash:digest('text-plan')},choice:{kind:'text-treatment-adoption-choice-1',action:'keep-native-overlay',approvalId:'approval',duplicationAcknowledgement:null,newLayerId:'new_layer',hideNativeIds:[],nativeCopies:[],preservation:'none'},nativeOffAssetId:'off',nativeOnAssetId:'on'};
 return {...created,documentId:null,resultingDocumentRevision:null,streamId:'assets',type:'ImageEditPreviewPrepared',payload:{preview:{previewId:'preview',documentId:'projection_document',documentRevision:'1',kind:'candidate-adoption',plan:ref(),source:image,preparedAssetId:'prepared',after:image,candidate}}};
}
export function derivedAsset(){
 const manifest=ref(),pixels=ref('application/x-ideogram-rgba8','24');
 return {id:'derived_asset',version:'1',purpose:'image',blob:ref('image/png','80'),dependencies:[manifest,pixels],safety:'unknown',availability:'available',qualification:'canonical-raster',measuredMediaType:'image/png',raster:{schemaVersion:1,pipeline:'cp1-f64-triangle-area-v1/'+digest('codec'),width:3,height:2,manifest,pixels,pixelIdentity:digest('pixels'),role:'derived',sourceAssetIds:['original'],conversion:null}};
}
