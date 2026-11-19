<script lang="ts">
import Input from "./Input.svelte";

let {
  id, label, name, type = "text", autocomplete, value = "", inputmode,
  required = false, disabled = false, hint, error, placeholder, minlength, maxlength,
}: {
  id: string;
  label: string;
  name: string;
  type?: "text" | "password";
  autocomplete?: "username" | "current-password" | "new-password" | "one-time-code" | "off";
  value?: string;
  inputmode?: "numeric";
  required?: boolean;
  disabled?: boolean;
  hint?: string;
  error?: string;
  placeholder?: string;
  minlength?: number;
  maxlength?: number;
} = $props();

const descriptionId = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);
</script>

<div class="grid gap-1.5">
  <label for={id} class="text-sm font-semibold {disabled ? 'text-[#777980]' : 'text-[#292a2f]'}">{label}</label>
  <Input {id} {name} {type} {autocomplete} {value} {inputmode} {required} {disabled} {placeholder} {minlength} {maxlength} invalid={!!error} describedby={descriptionId} />
  {#if error}
    <p id={`${id}-error`} role="alert" class="m-0 text-sm leading-5 text-[#c62e36]">{error}</p>
  {:else if hint}
    <p id={`${id}-hint`} class="m-0 text-sm leading-5 text-[#73757d]">{hint}</p>
  {/if}
</div>
