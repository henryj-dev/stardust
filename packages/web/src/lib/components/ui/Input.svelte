<script lang="ts">
let {
  id, name, type = "text", autocomplete, value = "", inputmode,
  required = false, disabled = false, invalid = false, describedby, placeholder, minlength, maxlength,
}: {
  id: string;
  name: string;
  type?: "text" | "password";
  autocomplete?: "username" | "current-password" | "new-password" | "one-time-code" | "off";
  value?: string;
  inputmode?: "numeric";
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  describedby?: string;
  placeholder?: string;
  minlength?: number;
  maxlength?: number;
} = $props();
</script>

<input
  {id} {name} {type} {autocomplete} {value} {inputmode} {required} {disabled} {placeholder} {minlength} {maxlength}
  aria-invalid={invalid || undefined}
  aria-describedby={describedby}
  class="min-h-12 w-full rounded-[10px] border bg-white px-4 py-2.5 text-base text-[#171719] placeholder:text-[#92949b] focus:outline-none disabled:cursor-not-allowed disabled:border-[#e3e4e7] disabled:bg-[#f1f2f4] disabled:text-[#777980] forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 {invalid ? 'border-[#c62e36] focus:border-[#c62e36]' : 'border-[#dedfe2] hover:enabled:border-[#b3b5bc] focus:border-[#0066ff]'}"
/>
