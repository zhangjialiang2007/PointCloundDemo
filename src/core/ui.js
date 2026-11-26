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

/** 在面板中创建一行下拉选择 */
export function addSelect(panel, { label, options, value, onChange }) {
  const row = document.createElement('div');
  row.className = 'row';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const select = document.createElement('select');
  for (const opt of options) {
    const item = document.createElement('option');
    item.value = opt.value;
    item.textContent = opt.label;
    select.appendChild(item);
  }
  select.value = value;
  select.addEventListener('change', () => onChange?.(select.value));

  row.append(labelEl, select);
  panel.appendChild(row);

  return { row, select };
}

/** 在面板中创建一行颜色选择，value 为 #rrggbb */
export function addColor(panel, { label, value, onChange }) {
  const row = document.createElement('div');
  row.className = 'row';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => onChange?.(input.value));

  row.append(labelEl, input);
  panel.appendChild(row);

  return { row, input };
}

/**
 * 在面板中创建一条多色标渐变色带（values 为若干 #rrggbb，按位置均匀分布）。
 * 色块单独占一行，返回 { row, inputs }。
 */
export function addColorBand(panel, { label, values, onChange }) {
  const row = document.createElement('div');
  row.className = 'row band-row';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const group = document.createElement('div');
  group.className = 'band-group';

  const current = [...values];
  const inputs = current.map((hex, i) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = hex;
    input.title = `色标 ${i + 1} / ${current.length}`;
    input.addEventListener('input', () => {
      current[i] = input.value;
      onChange?.(current);
    });
    group.appendChild(input);
    return input;
  });

  row.append(labelEl, group);
  panel.appendChild(row);

  return { row, inputs };
}

/** 在面板中创建一个整行按钮 */
export function addButton(panel, { label, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'panel-button';
  button.textContent = label;
  button.addEventListener('click', () => onClick?.(button));
  panel.appendChild(button);
  return button;
}
