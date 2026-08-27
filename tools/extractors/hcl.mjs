import path from 'node:path';
import { safeConfigUrl } from './config.mjs';

const header=/^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
const moduleHeader=/^\s*module\s+"([^"]+)"\s*\{/;
const declarationHeader=/^\s*(output|variable)\s+"([^"]+)"\s*\{/;
const localsHeader=/^\s*locals\s*\{/;
const address=/\b(?:(module\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*)|((?:data\.)?[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*)\.[A-Za-z_][\w-]*|((?:var|local)\.[A-Za-z_][\w-]*))\b/g;
const braces=line=>(line.match(/\{/g)||[]).length-(line.match(/\}/g)||[]).length;
const modulePath=file=>{
  const directory=path.posix.dirname(file);
  return directory==='.'||directory==='.terraform'?'.':directory.replace(/\/\.terraform$/,'')||'.';
};
const structuralTemplateTail=value=>{
  if (!value.includes('${')) return null;
  const tail=value.split(/\$\{[^}]*\}/g).at(-1)?.trim();
  return tail?.startsWith('/')&&/^\/[A-Za-z0-9/_-]+$/.test(tail)?tail:null;
};

export default { kind:'tf_resource', filePattern:/(?:\.tf$|(?:^|\/)\.terraform\/environment$|\.tfworkspace$)/i, scan(lines,ctx) {
  const currentModulePath=modulePath(ctx.file);
  if (/(?:^|\/)\.terraform\/environment$/i.test(ctx.file)||/\.tfworkspace$/i.test(ctx.file)) {
    const workspace=lines.map(line=>line.trim()).find(Boolean);
    return workspace?[ctx.fact('tf_workspace',1,{module_path:currentModulePath,environment:workspace})]:[];
  }

  const facts=[]; let current=null, depth=0;
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (!current) {
      const match=line.match(header);
      if (match) {
        current={kind:'resource',block:match[1],tf_type:match[2],name:match[3],address:`${match[1]==='data'?'data.':''}${match[2]}.${match[3]}`};
        current.fact=ctx.fact('tf_resource',i+1,{tf_type:match[2],name:match[3],block:match[1],address:current.address,module_path:currentModulePath,attributes:{}});
        facts.push(current.fact); depth=braces(line); if (depth<=0) current=null; continue;
      }
      const moduleMatch=line.match(moduleHeader);
      if (moduleMatch) {
        current={kind:'module',name:moduleMatch[1]};
        current.fact=ctx.fact('tf_module_call',i+1,{name:moduleMatch[1],module_path:currentModulePath,source:null});
        facts.push(current.fact); depth=braces(line); if (depth<=0) current=null; continue;
      }
      const declaration=line.match(declarationHeader);
      if (declaration) {
        facts.push(ctx.fact('tf_declaration',i+1,{declaration_kind:declaration[1],name:declaration[2],module_path:currentModulePath}));
        current={kind:declaration[1]}; depth=braces(line); if (depth<=0) current=null; continue;
      }
      if (localsHeader.test(line)) { current={kind:'locals'}; depth=braces(line); if (depth<=0) current=null; continue; }
    }
    if (!current) continue;
    if (current.kind==='resource') {
      let ref; address.lastIndex=0;
      while ((ref=address.exec(line))) { const target=ref[1]||ref[2]||ref[3]; if (target!==current.address) facts.push(ctx.fact('tf_ref',i+1,{from:current.address,to:target,module_path:currentModulePath})); }
      const attr=line.match(/^\s*(name|topic_arn|function_name|parameter_name|arn)\s*=\s*"([^"]+)"/);
      if (attr) current.fact.attributes[attr[1]]=attr[2];
      if (attr?.[1]==='name' && current.tf_type==='aws_ssm_parameter') facts.push(ctx.fact('config_key',i+1,{key_name:attr[2],role:'declared',resource:current.address,module_path:currentModulePath}));
      const value=line.match(/^\s*value\s*=\s*"([^"]+)"/);
      const url=value&&current.tf_type==='aws_ssm_parameter'&&safeConfigUrl(value[1]);
      if (url) facts.push(ctx.fact('config_value_url',i+1,{key:current.fact.attributes.name||current.name,url,source:'ssm',resource:current.address,module_path:currentModulePath}));
      else if (value&&current.tf_type==='aws_ssm_parameter') {
        const static_tail=structuralTemplateTail(value[1]);
        if (static_tail) facts.push(ctx.fact('config_value_template',i+1,{key:current.fact.attributes.name||current.name,static_tail,source:'ssm',resource:current.address,module_path:currentModulePath}));
      }
    } else if (current.kind==='module') {
      const source=line.match(/^\s*source\s*=\s*"([^"]+)"/);
      if (source) current.fact.source=source[1];
    } else if (current.kind==='locals') {
      const local=line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
      if (local) facts.push(ctx.fact('tf_declaration',i+1,{declaration_kind:'local',name:local[1],module_path:currentModulePath}));
    }
    depth+=braces(line); if (depth<=0) current=null;
  }
  return facts;
}};
