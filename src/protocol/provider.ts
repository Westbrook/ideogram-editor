/** Public, credential-free production provider state and deliberate dispatch authority. */
export type ProviderAuthorizationBody = {
  type:'AuthorizeProviderJob';jobId:string;attemptId:string;expectedVersion:string;reviewToken:string;
  configurationId:string;configurationHash:string;epoch:string;
  profileId:string;profileVersion:number;disclosureDigest:string;acknowledgeChargeAndPrivacy:true;
};
export type ProviderAuthorization = {
  id:string;configurationId:string;configurationHash:string;epoch:string;jobId:string;attemptId:string;
  reviewToken:string;profileId:string;profileVersion:number;disclosureDigest:string;authorizedAt:string;
};
export type ProviderPrivacyView = {
  id:string;version:number;evidenceDigest:string;disclosureDigest:string;disclosure:readonly string[];
  requestedStoreIO:'0';expirationSeconds:number;initialACL:'public';enforcement:'documented';
};
export type ProviderView = {
  protocolVersion:1;mode:'disabled'|'fal';ready:boolean;
  state:'disabled'|'ready'|'expired'|'limit-reached'|'unavailable';
  configurationId:string|null;configurationHash:string|null;epoch:string;credentialConfigured:boolean;
  operation:'generate';endpoint:'ideogram/v4';profile:ProviderPrivacyView|null;
  limits:null|{
    maximumRequests:number;maximumImages:number;usedRequests:number;usedImages:number;
    width:number;height:number;imagesPerRequest:1;format:'png';expansion:'None';expiresAt:string;
  };
  message:string;
};
