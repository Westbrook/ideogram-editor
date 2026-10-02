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
export type ProviderV4View = {
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

/** V45-A1: visible contract capability, never implicit paid dispatch authority. */
export type ProviderV45View = {
 protocolVersion:1;mode:'disabled'|'fal';ready:false;
 state:'disabled'|'admission-blocked'|'expired'|'limit-reached'|'unavailable';
 configurationId:string|null;configurationHash:string|null;epoch:string;credentialConfigured:boolean;
 operation:'generate-v45';endpoint:'ideogram/v4.5';profile:ProviderPrivacyView|null;
 admission:{policy:'unknown-withheld-1';state:'blocked';reason:'provider-safety-evidence-unavailable';ordinaryDisplay:false;adoption:false;export:false};
 limits:null|{maximumRequests:number;maximumImages:number;usedRequests:number;usedImages:number;
  width:1024;height:1024;imagesPerRequest:1;size:'square_hd';format:'provider-controlled';
  quality:'medium';enablePromptExpansion:boolean;expiresAt:string};
 message:string;
};
export type ProviderView=ProviderV4View|ProviderV45View;
