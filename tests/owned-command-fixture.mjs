import {modelMemoryURL} from './ui-model-module.mjs';
const {cloneOwnedModel}=await import(modelMemoryURL);
/** Legacy protocol fixtures supply deterministic raw command/upload results.
 * Wrap that test boundary in the actual reference-counted result owner; the
 * production EditorClient control tests separately verify wire admission. */
export function ownFixtureCommands(editor){
 editor.ownedCommand=async(...args)=>{const value=await editor.command(...args);return cloneOwnedModel('fixture-command-events',Array.isArray(value)?value:[]);};
 editor.withCommandEvents=async(body,work,...args)=>{const model=await editor.ownedCommand(body,...args);try{return await work(model.value);}finally{model.release();}};
 editor.ownedUpload=async(file,purpose,mediaType,...args)=>{const staged=await editor.upload(file,purpose,mediaType,...args);return cloneOwnedModel('fixture-upload',{protocolVersion:1,stagingId:staged.stagingId,purpose,expectedBytes:staged.expectedBytes??String(file.size),sha256:staged.sha256,mediaType});};
 editor.ownedCancelCandidateReview=async(...args)=>cloneOwnedModel('fixture-review-cancel',await editor.cancelCandidateReview(...args));
 return editor;
}
