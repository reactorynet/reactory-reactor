import { MetricSpecifications } from "../../types";

export default {
  "security": {
    weight: 0.05,
    target: 0.8,
    description: "Security is a measure of how secure the code is. It is a measure of how well the code protects against common security vulnerabilities and bad practices that creates security vulnerabilities."
  },
  "performance": {
    weight: 0.05,
    target: 0.8,
    description: "Performance is a measure of how well the code performs. It is a measure of how well the code performs under load and how well it scales."
  },
  "maintainability": {
    weight: 0.05,
    target: 0.8,
    description: "Maintainability is a measure of how easy it is to maintain the code. It is a measure of how easy it is to understand the code and how easy it is to make changes to the code."
  },
  "reliability": {
    weight: 0.05,
    target: 0.8,
    description: "Reliability is a measure of how reliable the code is. It is a measure of how well the code handles errors and how well it handles unexpected situations."
  },
  "readability": {
    weight: 0.05,
    target: 0.8,
    description: "Readability is a measure of how readable the code is. It is a measure of how easy it is to read the code and how easy it is to understand the code."
  },
  "testability": {
    weight: 0.05,
    target: 0.8,
    description: "Testability is a measure of how easy it is to test the code. It is a measure of how easy it is to write tests for the code and how easy it is to run the tests."
  },
  "portability": {
    weight: 0.05,
    target: 0.8,
    description: "Portability is a measure of how portable the code is. It is a measure of how easy it is to port the code to other platforms and how easy it is to port the code to other languages."
  },
  "usability": {
    weight: 0.05,
    target: 0.8,
    description: "Usability is a measure of how usable the code is. It is a measure of how easy it is to use the code and how easy it is to understand the code."
  },
  "accessibility": {
    weight: 0.05,
    target: 0.8,
    description: "Accessibility is a measure of how accessible the code is. It is a measure of how easy it is to access the code and how easy it is to understand the code."
  },
  "concurrency": {
    weight: 0.05,
    target: 0.8,
    description: "Concurrency is a measure of how concurrent the code is. It is a measure of how easy it is to write concurrent code and how easy it is to run concurrent code."
  },
  "internationalization": {
    weight: 0.05,
    target: 0.8,
    description: "Internationalization is a measure of how internationalized the code is. It is a measure of how easy it is to internationalize the code and how easy it is to localize the code."
  },
  "localization": {
    weight: 0.05,
    target: 0.8,
    description: "Localization is a measure of how localized the code is. It is a measure of how easy it is to localize the code and how easy it is to internationalize the code."
  },
  "documentation": {
    weight: 0.05,
    target: 0.8,
    description: "Documentation is a measure of how well documented the code is. It is a measure of how well the code is documented and how well the documentation is written."
  },
  "efficiency": {
    weight: 0.05,
    target: 0.8,
    description: "Efficiency is a measure of how efficient the code is. It is a measure of how efficient the code is and how efficient the code is written."
  },
  "correctness": {
    weight: 0.05,
    target: 0.8,
    description: "Correctness is a measure of how correct the code is. It is a measure of how correct the code is and how correct the code is written."
  },
  "robustness": {
    weight: 0.05,
    target: 0.8,
    description: "Robustness is a measure of how robust the code is. It is a measure of how robust the code is and how robust the code is written."
  },
  "flexibility": {
    weight: 0.05,
    target: 0.8,
    description: "Flexibility is a measure of how flexible the code is. It is a measure of how flexible the code is and how flexible the code is written."
  },
  "extensibility": {
    weight: 0.05,
    target: 0.8,
    description: "Extensibility is a measure of how extensible the code is. It is a measure of how extensible the code is and how extensible the code is written."
  },
  "reusability": {
    weight: 0.05,
    target: 0.8,
    description: "Reusability is a measure of how reusable the code is. It is a measure of how reusable the code is and how reusable the code is written."
  },
  "interoperability": {
    weight: 0.05,
    target: 0.8,
    description: "Interoperability is a measure of how interoperable the code is. It is a measure of how interoperable the code is and how interoperable the code is written."
  },
} as MetricSpecifications;
