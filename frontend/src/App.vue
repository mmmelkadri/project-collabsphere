<script setup lang="ts">
import { RouterView } from 'vue-router'
import Header from './components/Header.vue'
import Notification from './components/Notification.vue';
</script>

<template>
  <div class="flex flex-col relative mx-4 my-4 flex-1">
    <Header />
    <RouterView />
    <Notification/>
  </div>
</template>

<style scoped></style>
