<script setup lang="ts">
import { text } from './data'
const num = Math.random()
</script>

<template>
  <h3>HelloWorld ?{{ num }}</h3>
  <h4>text: {{ text }}</h4>
</template>
