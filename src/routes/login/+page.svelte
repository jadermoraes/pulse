<script lang="ts">
  import { _ } from 'svelte-i18n';
  let { form } = $props();
</script>
<main class="auth">
  <h1>{$_('auth.appName')}</h1>
  <form method="POST">
    <input name="email" type="email" placeholder={$_('auth.email')} required />
    <input name="password" type="password" placeholder={$_('auth.password')} required />
    {#if form?.error}<p class="err">{form.error}</p>{/if}
    <button>{$_('auth.signIn')}</button>
  </form>
</main>
