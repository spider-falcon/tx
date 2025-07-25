import { useState, useEffect } from 'react';

export default function Tx({ intervalTime = 8000 }) {
  const [symbol, setSymbol] = useState('0');
  const symbols = "!#^*)0+-";

  useEffect(() => {
    const interval = setInterval(() => {
      const newSymbol = symbols[Math.floor(Math.random() * symbols.length)];
      setSymbol(newSymbol);
      document.title = `0_${newSymbol}`;
    }, intervalTime + 100);

    return () => clearInterval(interval);
  }, [intervalTime]);

  return <p className='looopgo'>0_{symbol}</p>; // ✅ JSX output
}
