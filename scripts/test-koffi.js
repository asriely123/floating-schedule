// 最小验证：koffi 能否在 Electron 主进程内加载并声明 user32 函数
const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const f = user32.func(
      'int SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags)'
    );
    console.log('[koffi-test] ok, SetWindowPos declared:', typeof f === 'function');
  } catch (e) {
    console.log('[koffi-test] caught JS error:', e.message);
  }
  app.quit();
});
