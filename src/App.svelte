<script lang="ts">
  // Header/крошки и Footer общаются со сценой только через стор (`uiCommand`),
  // никогда напрямую — иначе гонки между DOM- и Three.js-мирами.
  import Header from "./lib/components/Header.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import Scene from "./lib/components/Scene.svelte";
  import CleanupConfirm from "./lib/components/CleanupConfirm.svelte";
  import SettingsPanel from "./lib/components/SettingsPanel.svelte";
  import LegendPanel from "./lib/components/LegendPanel.svelte";
  import HotkeysHelp from "./lib/components/HotkeysHelp.svelte";
  import Hotkeys from "./lib/components/Hotkeys.svelte";
  import Toast from "./lib/components/Toast.svelte";
</script>

<Hotkeys />

<div class="app">
  <Header />
  <main class="viewport">
    <Scene />
  </main>
  <Footer />
</div>

<SettingsPanel />

<LegendPanel />

<CleanupConfirm />

<HotkeysHelp />

<Toast />

<style>
  .app {
    display: grid;
    /* minmax(0,1fr) на viewport критично: без него canvas распирает грид и
       строки уезжают за экран. */
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
  }
  .viewport {
    position: relative;
    overflow: hidden;
    min-height: 0;
  }
</style>
