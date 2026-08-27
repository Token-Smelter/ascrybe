function guarded(records, enabled) {
  if (enabled) total += records;
}

function skipped(records, skip) {
  if (skip) return;
  total += records;
}

function caller(value) {
  writer(value);
}

function writer(value) {
  total += value;
}

function first(value) { second(value); }
function second(value) { third(value); }
function third(value) { fourth(value); }
function fourth(value) { fifth(value); }
function fifth(value) { sixth(value); }
function sixth(value) { seventh(value); }
function seventh(value) { eighth(value); }
function eighth(value) { ninth(value); }
function ninth(value) { tenth(value); }
function tenth(value) { total += value; }

function beyondFirst(value) { beyondSecond(value); }
function beyondSecond(value) { beyondThird(value); }
function beyondThird(value) { beyondFourth(value); }
function beyondFourth(value) { total += value; }
