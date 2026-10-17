'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/repair-visit.js'), 'utf8');

function fixture(tools, execution) {
  const forms = [], buttons = [], calls = [];
  const context = { window:{}, document:{} };
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `window.testTools={
    render(tools,execution){state={tools,execution};return toolsMarkup();},
    bind(dialogValue,saveValue){dialog=dialogValue;save=saveValue;bind();}
  };})();`), context);
  const html = context.window.testTools.render(tools, execution);
  for (const tool of tools) {
    if (html.includes(`data-tool-key="${tool.key}"`)) forms.push({
      dataset:{toolKey:tool.key}, valid:true, value:'The fault is electrical and does not require evacuation.',
      reportValidity(){return this.valid;}, querySelector(){return {value:this.value};},
      addEventListener(event, handler){this.submit=handler;},
    });
    if (html.includes(`data-require-tool="${tool.key}"`)) buttons.push({dataset:{requireTool:tool.key}});
  }
  const dialog = { querySelector:selector=>selector==='.ru-close'?{}:null, querySelectorAll:selector=>selector==='[data-tool-decision]'?forms:selector==='[data-require-tool]'?buttons:[] };
  context.window.testTools.bind(dialog, (action, body)=>calls.push({action,body:JSON.parse(JSON.stringify(body))}));
  return {html,forms,buttons,calls};
}

test('a missing tool offers a reasoned Not required decision using its exact identity', () => {
  const f = fixture([{key:'equipment:pump',name:'Vacuum pump',ready:false}]);
  assert.match(f.html, /Not required for this repair/);
  assert.match(f.html, /minlength="5" maxlength="500"/);
  f.forms[0].submit({preventDefault(){}});
  assert.deepEqual(f.calls, [{action:'tool-decision',body:{key:'equipment:pump',notRequired:true,reason:f.forms[0].value}}]);
});

test('invalid reasons stay on the tool form without sending a decision', () => {
  const f = fixture([{key:'equipment:pump',name:'Vacuum pump',ready:false}]);
  f.forms[0].valid=false;
  f.forms[0].submit({preventDefault(){}});
  assert.equal(f.calls.length, 0);
});

test('the saved decision displays its reason and can require the tool again before repair starts', () => {
  const tool = {key:'equipment:pump',name:'Vacuum pump',ready:true,notRequired:true,detail:'Not required for this repair',decisionReason:'Electrical fault only.'};
  const f = fixture([tool]);
  assert.match(f.html, /Electrical fault only/);
  assert.equal(f.forms.length, 0);
  f.buttons[0].onclick();
  assert.equal(f.calls[0].body.notRequired, false);
  const running = fixture([tool], {status:'in_progress'});
  assert.equal(running.forms.length, 0);
  assert.equal(running.buttons.length, 0);
});

test('tool names and recorded reasons are escaped and each missing tool keeps its own reason field', () => {
  const f = fixture([{key:'equipment:one',name:'<img src=x>',ready:false},
    {key:'equipment:two',name:'Gauge',ready:false},
    {key:'equipment:three',name:'Pump',ready:true,decisionReason:'<script>alert(1)</script>'}]);
  assert.doesNotMatch(f.html, /<img|<script>/);
  assert.match(f.html, /name="toolReason:equipment:one"/);
  assert.match(f.html, /name="toolReason:equipment:two"/);
});
