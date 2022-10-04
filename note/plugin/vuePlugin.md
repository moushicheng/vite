## config

定义两个参数，暂时不知道做什么用

```javascript
    config(config) {
      return {
        define: {
          __VUE_OPTIONS_API__: config.define?.__VUE_OPTIONS_API__ ?? true,
          __VUE_PROD_DEVTOOLS__: config.define?.__VUE_PROD_DEVTOOLS__ ?? false
        },
        ssr: {
          external: config.legacy?.buildSsrCjsExternalHeuristics
            ? ['vue', '@vue/server-renderer']
            : []
        }
      }
    },
```

重点是 transform，它完成了对 vue 文件的转换

```typescript
 transform(code, id, opt) {
      const ssr = opt?.ssr === true;
      const { filename, query } = parseVueRequest(id);
      if (query.raw) {
        return;
      }
      if (!filter(filename) && !query.vue) {
        if (!query.vue && refTransformFilter(filename) && options.compiler.shouldTransformRef(code)) {
          return options.compiler.transformRef(code, {
            filename,
            sourceMap: true
          });
        }
        return;
      }
      if (!query.vue) {
        return transformMain(
          code,
          filename,
          options,
          this,
          ssr,
          customElementFilter(filename)
        );
      } else {
        const descriptor = query.src ? getSrcDescriptor(filename, query) : getDescriptor(filename, options);
        if (query.type === "template") {
          return transformTemplateAsModule(code, descriptor, options, this, ssr);
        } else if (query.type === "style") {
          return transformStyle(
            code,
            descriptor,
            Number(query.index),
            options,
            this,
            filename
          );
        }
      }
    }
```

首先是获取 id 的 filename 和查询参数
形如 id= ./App.vue?vue="vueContent"
会被拆成
{
filename='./App.vue'
query={
vue:'vueContent'
}
}

```typescript
const ssr = opt?.ssr === true
const { filename, query } = parseVueRequest(id)
```

然后根据查询参数，来执行不同操作

主要逻辑还是位于 transformMain
它做了如下几件事 0. 生成 Descriptor

1. 对 script 转换
2. 对 template 转换
3. 对 styles 转换
4. 对 CustomBlock 转换
5. 对 hmr 支持
6. 对 ssr 支持
7. 对 sourcemap 支持
8. 通过 Esbuild 转换 lang=TS 的 script

## Descriptor

```typescript
const { descriptor, errors } = createDescriptor(filename, code, options)
```

createDescriptor
其中,
compiler.parse 来自 vuejs/core > packages\compiler-sfc\src\parse.ts

```typescript
function createDescriptor(
  filename: string,
  source: string,
  { root, isProduction, sourceMap, compiler }: ResolvedOptions
): SFCParseResult {
  const { descriptor, errors } = compiler.parse(source, {
    filename,
    sourceMap
  })

  // ensure the path is normalized in a way that is consistent inside
  // project (relative to root) and on different systems.
  //确保在项目内部(相对于根目录)和不同系统上有相同规范的路径。
  const normalizedPath = slash(path.normalize(path.relative(root, filename)))
  descriptor.id = getHash(normalizedPath + (isProduction ? source : ''))

  //设置缓存
  cache.set(filename, descriptor)
  return { descriptor, errors }
}
```

parse 解析标签节点，并对每个生成 sourcemap，最后处理 cssVars 等附带属性，返回 descriptor

descriptor 整体结构

![image-20220930173936706](C:\Users\moush\AppData\Roaming\Typora\typora-user-images\image-20220930173936706.png)对于 template

![image-20220930173857796](C:\Users\moush\AppData\Roaming\Typora\typora-user-images\image-20220930173857796.png)

对于 scriptSetup

![image-20220930173949554](C:\Users\moush\AppData\Roaming\Typora\typora-user-images\image-20220930173949554.png)

## 转换 script 代码

genScriptCode 就是将 ast 转换成 Vue render

入口

```typescript
// script
const { code: scriptCode, map: scriptMap } = await genScriptCode(
  descriptor,
  options,
  pluginContext,
  ssr
)
```

genScriptCode 分析 script 内部的代码，并将其解析成由 defineComponent 定义的 setup
相当于

```javascript
//Origin Code
```

转变为

```javascript
const _sfc_main = /*#__PURE__*/_defineComponent({
  __name: 'ComponentName.vue',
  setup(__props, { expose }) {
 	expose();

    //Origin Code

    const __returned__ = {
      //从Origin Code 分析出来的变量
      foo:1
    }
    Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true })
    return __returned__
  }
}
```

源码其实不太用看，因为大多数细节都隐藏在了 vuejs/core 的 complier 里面。

```typescript
function genScriptCode(descriptor, options, pluginContext, ssr) {
  let scriptCode = `const _sfc_main = {}`
  let map
  //生成模板对应的渲染函数
  const script = resolveScript(descriptor, options, ssr)
  if (script) {
    if (
      (!script.lang || (script.lang === 'ts' && options.devServer)) &&
      !script.src
    ) {
      const userPlugins = options.script?.babelParserPlugins || []
      const defaultPlugins =
        script.lang === 'ts'
          ? userPlugins.includes('decorators')
            ? ['typescript']
            : ['typescript', 'decorators-legacy']
          : []
      scriptCode = options.compiler.rewriteDefault(
        script.content,
        '_sfc_main',
        [...defaultPlugins, ...userPlugins]
      )
      map = script.map
    } else {
      if (script.src) {
        await linkSrcToDescriptor(script.src, descriptor, pluginContext, false)
      }
      const src = script.src || descriptor.filename
      const langFallback =
        (script.src && path__default.extname(src).slice(1)) || 'js'
      const attrsQuery = attrsToQuery(script.attrs, langFallback)
      const srcQuery = script.src ? `&src=true` : ``
      const query = `?vue&type=script${srcQuery}${attrsQuery}`
      const request = JSON.stringify(src + query)
      scriptCode = `import _sfc_main from ${request}
export * from ${request}`
    }
  }
  return {
    code: scriptCode,
    map
  }
}
```

最后生成的 code

```typescript
//原始
<template>
  <div>
    <h1 class="text-black">Tailwind app</h1>
    {{ foo }}
  </div>
  <router-view />
</template>

<script setup lang="ts">
import { ref } from 'vue'
const foo = ref(42)
</script>

//更新后
import { defineComponent as _defineComponent } from 'vue'
import { ref } from 'vue'

const _sfc_main = /*#__PURE__*/_defineComponent({
  __name: 'App',
  setup(__props, { expose }) {
 	expose();

    const foo = ref(42)

    const __returned__ = { foo }
    Object.defineProperty(__returned__, '__isScriptSetup', { enumerable: false, value: true })
    return __returned__
    }
})
```

## 转换模板代码

```typescript
// template
const hasTemplateImport =
  descriptor.template && !isUseInlineTemplate(descriptor, !devServer)

let templateCode = ''
let templateMap: RawSourceMap | undefined = undefined
if (hasTemplateImport) {
  ;({ code: templateCode, map: templateMap } = await genTemplateCode(
    descriptor,
    options,
    pluginContext,
    ssr
  ))
}
```

转换前

```Html
<div>
  <h1 class="text-black">Tailwind app</h1>
  {{ foo }}
</div>
<router-view />
```

转换后

```typescript
import {
  createElementVNode as _createElementVNode,
  toDisplayString as _toDisplayString,
  createTextVNode as _createTextVNode,
  resolveComponent as _resolveComponent,
  createVNode as _createVNode,
  Fragment as _Fragment,
  openBlock as _openBlock,
  createElementBlock as _createElementBlock
} from 'vue'

const _hoisted_1 = /*#__PURE__*/ _createElementVNode(
  'h1',
  { class: 'text-black' },
  'Tailwind app',
  -1 /* HOISTED */
)

export function render(_ctx, _cache, $props, $setup, $data, $options) {
  const _component_router_view = _resolveComponent('router-view')

  return (
    _openBlock(),
    _createElementBlock(
      _Fragment,
      null,
      [
        _createElementVNode('div', null, [
          _hoisted_1,
          _createTextVNode(' ' + _toDisplayString($setup.foo), 1 /* TEXT */)
        ]),
        _createVNode(_component_router_view)
      ],
      64 /* STABLE_FRAGMENT */
    )
  )
}
```
