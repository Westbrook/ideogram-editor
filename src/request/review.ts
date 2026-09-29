import type {BlobRef} from '../protocol/store.js';
import type {Request,Draft} from './core.js';
import type {DraftFence} from '../protocol/history.js';
import type {estimate} from './core.js';
export type RequestReview={kind:'request-review-1';id:string;token:string;owner:string;draft:DraftFence;draftAsset:string;documentId:string;documentRevision:string;request:Request;endpoint:string;schemaHash:string;routeHash:string;dependencyHash:string;template:BlobRef;prompt:BlobRef;conversion:Draft['conversion'];inactive:Draft['inactive'];destination:'retained-candidates';privacy:'minimum-retention-unqualified';estimate:ReturnType<typeof estimate>;dispatch:false};
