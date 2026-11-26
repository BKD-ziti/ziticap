import { useState } from 'preact/hooks';
import { Editor } from './ui/Editor';
import { Home } from './ui/Home';
import { SettingsSheet } from './ui/Settings';
import { Toast } from './ui/Toast';

export function App() {
  const [screen, setScreen] = useState<'home' | 'editor'>('home');
  const [needFile, setNeedFile] = useState(false);
  const [settings, setSettings] = useState(false);

  return (
    <>
      {screen === 'home' ? (
        <Home
          openSettings={() => setSettings(true)}
          onOpen={(nf) => {
            setNeedFile(nf);
            setScreen('editor');
          }}
        />
      ) : (
        <Editor needFile={needFile} openSettings={() => setSettings(true)} onBack={() => setScreen('home')} />
      )}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
      <Toast />
    </>
  );
}
