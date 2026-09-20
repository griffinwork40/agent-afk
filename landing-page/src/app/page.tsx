import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Features from "./components/Features";
import HowItWorks from "./components/HowItWorks";
import Comparison from "./components/Comparison";
import Architecture from "./components/Architecture";
import GettingStarted from "./components/GettingStarted";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Comparison />
        <Architecture />
        <GettingStarted />
      </main>
      <Footer />
    </>
  );
}
