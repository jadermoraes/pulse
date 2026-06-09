<script lang="ts">
  import { _ } from 'svelte-i18n';
  let { form } = $props();
</script>
<main class="auth">
  <h1>{$_('auth.setupTitle')}</h1>
  <p>{$_('auth.setupSubtitle')}</p>
  <form method="POST">
    <input name="email" type="email" placeholder={$_('auth.email')} required />
    <input name="password" type="password" placeholder={$_('auth.passwordHint')} required />
    {#if form?.error}<p class="err">{form.error}</p>{/if}
    <button>{$_('auth.createAccount')}</button>
  </form>
</main>
