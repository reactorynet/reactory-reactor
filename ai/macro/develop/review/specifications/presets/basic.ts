import { MetricSpecifications } from "../../types";

export default {

  "security": {
    weight: 0.2,
    target: 0.8,
    description: "Security is a measure of how secure the code is. It is a measure of how well the code protects against common security vulnerabilities and bad practices that creates security vulnerabilities."
  },
  "performance": {
    weight: 0.2,
    target: 0.8,
    description: "Performance is a measure of how well the code performs. It is a measure of how well the code performs under load and how well it scales."
  },
  
  "testability": {
    weight: 0.2,
    target: 0.8,
    description: "Testability is a measure of how easy it is to test the code. It is a measure of how easy it is to write tests for the code and how easy it is to run the tests."
  },
  
  "internationalization": {
    weight: 0.2,
    target: 0.8,
    description: "Internationalization is a measure of how internationalized the code is. It is a measure of how easy it is to internationalize the code and how easy it is to localize the code."
  },

  "localization": {
    weight: 0.2,
    target: 0.8,
    description: "Localization is a measure of how localized the code is. It is a measure of how easy it is to localize the code and how easy it is to internationalize the code."
  },
  
  "correctness": {
    weight: 0.2,
    target: 0.8,
    description: "Correctness is a measure of how correct the code is. It is a measure of how correct the code is and how correct the code is written."
  },
  "robustness": {
    weight: 0.2,
    target: 0.8,
    description: "Robustness is a measure of how robust the code is. It is a measure of how robust the code is and how robust the code is written."
  },
  
  "interoperability": {
    weight: 0.2,
    target: 0.8,
    description: "Interoperability is a measure of how interoperable the code is. It is a measure of how interoperable the code is and how interoperable the code is written."
  },
} as MetricSpecifications;
