/**
 * 参数面板的轻量控件，供各示例复用。
 */

/** 在面板中创建一行滑块，返回 { row, setValue } */
export function addSlider(panel, { label, min, max, step = 1, value, format = (v) => v, onInput }) {
  const row = document.createElement('div');
  row.className = 'row';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const valueEl = document.createElement('span');
  valueEl.className = 'value';
  valueEl.textContent = format(Number(input.value));

  input.addEventListener('input', () => {
    const v = Number(input.value);
    valueEl.textContent = format(v);
    onInput?.(v);
  });

  row.append(labelEl, input, valueEl);
  panel.appendChild(row);

  return {
    row,
    setValue(v) {
      input.value = String(v);
      valueEl.textContent = format(v);
    },
  };
}

/** 在面板中创建一行复选框 */
export function addCheckbox(panel, { label, checked = true, onChange }) {
  const row = document.createElement('div');
  row.className = 'row';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.style.accentColor = '#4ea1ff';
  input.addEventListener('change', () => onChange?.(input.checked));

  row.append(labelEl, input);
  panel.appendChild(row);

  return { row, input };
}

/** 在面板中创建提示文本 */
export function addHint(panel, text) {
  const el = document.createElement('div');
  el.className = 'hint';
  el.textContent = text;
  panel.appendChild(el);
  return el;
}
