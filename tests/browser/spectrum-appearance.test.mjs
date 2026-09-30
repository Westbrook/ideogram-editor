import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restoreAppearance,setAppearance,isAppearance} from '../../src/theme/appearance.ts';
test('Appearance preference handles valid, invalid, missing and unavailable storage',()=>{
  const priorDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const priorStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  const dataset={};let saved=null;
  try{
    Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{dataset}}});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>saved,setItem:(_key,value)=>{saved=value;}}});
    for(const value of [null,'invalid','',undefined]){saved=value;restoreAppearance();assert.equal(dataset.enAppearance,'auto');}
    for(const value of ['auto','light','dark']){setAppearance(value);assert.equal(saved,value);dataset.enAppearance='';restoreAppearance();assert.equal(dataset.enAppearance,value);}
    for(const value of [null,undefined,'system',1,{}])assert.equal(isAppearance(value),false);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('Unavailable');}});
    restoreAppearance();assert.equal(dataset.enAppearance,'auto');
    setAppearance('dark');assert.equal(dataset.enAppearance,'dark');
  }finally{
    if(priorDocument)Object.defineProperty(globalThis,'document',priorDocument);else delete globalThis.document;
    if(priorStorage)Object.defineProperty(globalThis,'localStorage',priorStorage);else delete globalThis.localStorage;
  }
});
