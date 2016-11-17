module.exports = (p) => `
<html>
  <head>
    <meta name='viewport' content='width=device-width, initial-scale=1.0' />
    ${p.head || ''}    
    ${p.styles || ''}    
    <script>window.IS_REACT = true</script>
  </head>
  <body>
    <div id='app'>Loading</div>
    <script type='application/json' id='bundle'>${JSON.stringify(p.modelBundle)}</script>
    <script defer src='${p.jsBundle}'></script>    
  </body>
</html>
`
