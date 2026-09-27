"use strict";
let owned=null,original=null;const calls=[];
const need=(ok,message)=>{if(!ok)throw Error(message);};
async function ownedTab(){need(owned,'OWNED_TAB_NOT_BOUND');const tab=await chrome.tabs.get(owned.id);need(tab.url===owned.url&&tab.windowId===owned.windowId,'OWNED_TAB_CHANGED');return tab;}
async function state(){const t=await ownedTab();return {tabId:t.id,windowId:t.windowId,url:t.url,active:t.active,zoom:await chrome.tabs.getZoom(t.id),settings:await chrome.tabs.getZoomSettings(t.id)};}
globalThis.c6Zoom=Object.freeze({
 async bind(url){need(!owned,'ALREADY_BOUND');const u=new URL(url);need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.hash&&!u.search,'NOT_EXACT_OWNED_LOOPBACK');const tabs=await chrome.tabs.query({url});need(tabs.length===1&&tabs[0].url===url,'AMBIGUOUS_OWNED_TAB');owned={id:tabs[0].id,url,windowId:tabs[0].windowId};original=await state();calls.push({at:new Date().toISOString(),method:'bind',state:original});return original;},
 async set200(){const t=await ownedTab();await chrome.tabs.setZoomSettings(t.id,{mode:'automatic',scope:'per-tab'});calls.push({at:new Date().toISOString(),method:'setZoomSettings',tabId:t.id,settings:{mode:'automatic',scope:'per-tab'}});await chrome.tabs.setZoom(t.id,2);calls.push({at:new Date().toISOString(),method:'setZoom',tabId:t.id,factor:2});return state();},
 async read(){return state();},
 async restore(){const t=await ownedTab();await chrome.tabs.setZoom(t.id,original.zoom);await chrome.tabs.setZoomSettings(t.id,{mode:original.settings.mode,scope:original.settings.scope});const restored=await state();need(restored.zoom===original.zoom&&JSON.stringify(restored.settings)===JSON.stringify(original.settings),'ZOOM_RESTORE_MISMATCH');calls.push({at:new Date().toISOString(),method:'restore',tabId:t.id,state:restored});return restored;},
 log(){return calls;}
});
