# TextField

Labelled single-line input on a sunken well.

- Provide `label` always. `hint` for help, `error` replaces it and says what to do.
- `mono` for codes, domains, IDs and amounts. Code fields accept paste and password managers; never call our codes "password".
- On mobile the input text is 16px.

## Props

```ts
export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> { label?: string; hint?: string; error?: string; mono?: boolean; prefix?: string }
```

## Usage

```js
// window.AgentLink is defined by bundle.js; React 18 must be on the page first.
const { TextField } = window.AgentLink;
```

Live example: `../previews/TextField.html` (open through the screens preview server).
