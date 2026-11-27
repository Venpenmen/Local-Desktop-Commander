import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBridge } from './bridge.mjs';
import { createGateway } from './gateway.mjs';
import { configStatus, createInstance, writeAtomicJson } from './config.mjs';

export class GeminiRunner {
  constructor(runtime,{id='gemini-c3',onEvent=()=>{},timeout=10000}={}){
    this.runtime=resolve(runtime);this.id=id;this.onEvent=onEvent;this.timeout=timeout;
    this.instance=join(this.runtime,this.id);this.config=createInstance(this.runtime,id);
    this.bridge=null;this.gateway=null;this.starting=false;this.latestToken=null;
    this.stateFile=join(this.instance,'state.json');
    this.targetFile=join(this.instance,'target.json');
    if(existsSync(this.targetFile)) this.config=createInstance(this.runtime,id,JSON.parse(readFileSync(this.targetFile,'utf8')));
  }
  get status(){
    const live=this.gateway?.status();
    const effective=this.bridge?.config??null;
    return {instance:this.id,transport:'gemini',state:live?.state??(this.starting?'starting':'stopped'),
      pid:live?.pid??null,enginePid:this.bridge?.pid??null,port:live?.port??null,
      fileAccess:configStatus(effective,this.config),toolCount:this.bridge?.toolList().length??null};
  }
  setTarget(target){
    if(this.gateway||this.starting)throw Error('STOP_BEFORE_CHANGE');
    const next=createInstance(this.runtime,this.id,target);
    writeAtomicJson(this.targetFile,next);
    this.config=next;
    this.record();
    return this.status;
  }
  record(){writeAtomicJson(this.stateFile,this.status);}
  async start(){
    if(this.gateway||this.starting)throw Error('ALREADY_RUNNING');
    this.starting=true;
    try{
      const log=event=>this.onEvent({instance:this.id,...event});
      const bridge=await createBridge(this.config,this.instance,{onEvent:log,timeout:this.timeout});
      this.bridge=bridge;
      const gateway=await createGateway(bridge,{timeout:this.timeout,onEvent:log});
      this.gateway=gateway;this.latestToken=gateway.token;this.record();
      return {...this.status,token:gateway.token};
    }catch(error){await this.bridge?.close().catch(()=>{});this.bridge=null;throw error;}
    finally{this.starting=false;}
  }
  async stop(){
    if(!this.gateway&&!this.bridge)return this.status;
    try{await this.gateway?.close();}
    finally{await this.bridge?.close();this.gateway=null;this.bridge=null;this.latestToken=null;this.record();}
    return this.status;
  }
  async restart(){
    await this.stop();
    return this.start();
  }
}
