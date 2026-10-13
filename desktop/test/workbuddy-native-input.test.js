'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync}=require('node:child_process');
test('native text input preserves Unicode and newlines, uses the correct Windows ABI and never submits with Enter', {skip:process.platform!=='win32'},()=>{
 const out=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'workbuddy-native-input-fixture.ps1')],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.match(out,/native text input fixture passed/);
});
