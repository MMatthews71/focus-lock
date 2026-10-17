// Corner warning banner: just shows the text it was given.
const text = new URLSearchParams(location.search).get('text') || '';
document.getElementById('text').textContent = text;
