const error = new URLSearchParams(location.search).get('error');
if (error) {
  document.body.classList.add('error');
  document.getElementById('message').textContent = error;
}
