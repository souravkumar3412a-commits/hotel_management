(function(){
    var splash = document.getElementById('splashScreen');
    var skipBtn = document.getElementById('splashSkip');
    var dismissed = false;
    function dismissSplash(){
      if(dismissed) return;
      dismissed = true;
      splash.classList.add('hide');
      setTimeout(function(){ splash.style.display = 'none'; }, 650);
    }
    var autoTimer = setTimeout(dismissSplash, 3800);
    skipBtn.addEventListener('click', function(){ clearTimeout(autoTimer); dismissSplash(); });
  })();